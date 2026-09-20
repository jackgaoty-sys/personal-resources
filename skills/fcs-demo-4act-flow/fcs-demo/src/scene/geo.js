// 真实地理底图：拼接卫星影像瓦片 + 地形高程瓦片，生成一块带真实地形的网格
//
// 已实测可用且允许跨域的三个服务：
//   卫星影像  Esri World Imagery   {z}/{y}/{x}   (注意 y 在前)
//   地形高程  AWS Terrain Tiles    {z}/{x}/{y}   (Terrarium 编码)
//
// 瓦片方案是 Web Mercator（EPSG:3857），影像与高程共用同一套 (z,x,y) 编号。
//
// 单位换算：局部切平面近似（几公里范围内足够准）
//   x = (lon - lon0) * 111320 * cos(lat0)      东为正
//   z = -(lat - lat0) * 110540                 北为 -z
import * as THREE from "three";

export const IMAGERY_URL = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
export const DEM_URL = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const TS = 256;                       // 瓦片像素边长
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320;

// ── 瓦片编号 ↔ 经纬度 ──────────────────────────────────────
export function lonToTileX(lon, z) { return (lon + 180) / 360 * 2 ** z; }
export function latToTileY(lat, z) {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z;
}
export function tileXToLon(x, z) { return x / 2 ** z * 360 - 180; }
export function tileYToLat(y, z) {
  const n = Math.PI - 2 * Math.PI * y / 2 ** z;
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// ── 局部坐标系换算 ────────────────────────────────────────
export function makeProjector(lat0, lon0) {
  const k = Math.cos(lat0 * Math.PI / 180);
  return {
    toX: (lon) => (lon - lon0) * M_PER_DEG_LON * k,
    toZ: (lat) => -(lat - lat0) * M_PER_DEG_LAT,
  };
}

async function fetchBitmap(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await createImageBitmap(await res.blob());
}

/**
 * 构建真实地理底图。
 * @param {number} lat0 原点纬度（= 飞机起始纬度）
 * @param {number} lon0 原点经度
 * @param {object} opt  { zoom, grid }
 * @returns {Promise<{mesh, size, center:{lat,lon}, dispose}>}
 */
export async function buildGeoGround(lat0, lon0, { zoom = 12, grid = 5 } = {}) {
  const proj = makeProjector(lat0, lon0);

  // 以原点为中心，取 grid×grid 个瓦片
  const cx = Math.floor(lonToTileX(lon0, zoom));
  const cy = Math.floor(latToTileY(lat0, zoom));
  const half = Math.floor(grid / 2);
  const x0 = cx - half, y0 = cy - half;

  // 瓦片网格覆盖的经纬度范围
  const westLon = tileXToLon(x0, zoom);
  const eastLon = tileXToLon(x0 + grid, zoom);
  const northLat = tileYToLat(y0, zoom);
  const southLat = tileYToLat(y0 + grid, zoom);

  const wx0 = proj.toX(westLon), wx1 = proj.toX(eastLon);
  const wz0 = proj.toZ(northLat), wz1 = proj.toZ(southLat);
  const sizeX = wx1 - wx0, sizeZ = wz1 - wz0;

  // ── 并行取瓦片 ──
  const jobs = [];
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      jobs.push({ i, j, x: x0 + i, y: y0 + j });
    }
  }
  const results = await Promise.all(jobs.map(async (t) => {
    const [img, dem] = await Promise.allSettled([
      fetchBitmap(IMAGERY_URL(zoom, t.x, t.y)),
      fetchBitmap(DEM_URL(zoom, t.x, t.y)),
    ]);
    return { ...t, img: img.status === "fulfilled" ? img.value : null, dem: dem.status === "fulfilled" ? dem.value : null };
  }));

  const imgOk = results.filter((r) => r.img).length;
  const demOk = results.filter((r) => r.dem).length;
  if (imgOk === 0) throw new Error("影像瓦片全部拉取失败（网络或跨域问题）");

  // ── 影像拼成一张大图 ──
  const cv = document.createElement("canvas");
  cv.width = cv.height = grid * TS;
  const g = cv.getContext("2d");
  for (const r of results) if (r.img) g.drawImage(r.img, r.i * TS, r.j * TS);

  // ── 高程解成二维数组（Terrarium 编码：elev = R*256 + G + B/256 - 32768）──
  const demW = grid * TS;
  const elev = new Float32Array(demW * demW).fill(0);
  let haveDem = false;
  for (const r of results) {
    if (!r.dem) continue;
    haveDem = true;
    const tc = document.createElement("canvas");
    tc.width = tc.height = TS;
    const tg = tc.getContext("2d", { willReadFrequently: true });
    tg.drawImage(r.dem, 0, 0);
    const d = tg.getImageData(0, 0, TS, TS).data;
    for (let py = 0; py < TS; py++) {
      for (let px = 0; px < TS; px++) {
        const s = (py * TS + px) * 4;
        const h = d[s] * 256 + d[s + 1] + d[s + 2] / 256 - 32768;
        const gx = r.i * TS + px, gy = r.j * TS + py;
        elev[gy * demW + gx] = h;
      }
    }
  }

  // ── 生成地形网格：顶点按高程抬起，UV 贴卫星影像 ──
  const SEG = 192;                             // 192×192 段（约 38km 范围下约 200m 网格）
  const geo = new THREE.PlaneGeometry(sizeX, sizeZ, SEG, SEG);
  const pos = geo.attributes.position;
  const demAt = (u, v) => {                    // u,v ∈ [0,1]
    const gx = Math.min(demW - 1, Math.max(0, Math.round(u * (demW - 1))));
    const gy = Math.min(demW - 1, Math.max(0, Math.round(v * (demW - 1))));
    return elev[gy * demW + gx];
  };
  for (let k = 0; k < pos.count; k++) {
    const u = pos.getX(k) / sizeX + 0.5;       // 0..1，西→东
    const v = 0.5 - pos.getY(k) / sizeZ;       // 0..1，北→南
    pos.setZ(k, haveDem ? demAt(u, v) : 0);    // PlaneGeometry 未旋转前 z 即"高度"
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    map: tex, roughness: 1, metalness: 0,
  }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set((wx0 + wx1) / 2, 0, (wz0 + wz1) / 2);
  mesh.renderOrder = -1;

  return {
    mesh,
    sizeX, sizeZ,
    tiles: { imgOk, demOk, total: results.length },
    haveDem,
    zoom, grid,
    center: { lat: (northLat + southLat) / 2, lon: (westLon + eastLon) / 2 },
    bounds: { wx0, wx1, wz0, wz1 },
    /** 查任意世界坐标处的地形高度（米，MSL）。越界返回 0。 */
    heightAt(worldX, worldZ) {
      if (!haveDem) return 0;
      const u = (worldX - wx0) / sizeX;
      const v = (worldZ - wz0) / sizeZ;
      if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
      return demAt(u, v);
    },
    dispose: () => { geo.dispose(); tex.dispose(); mesh.material.dispose(); },
  };
}

/** 飞机离底图边缘太近就该重载了。
 *  余量必须大于 fogFar/尺寸，否则重载前就能看见底图边界。
 *  38km 底图 + 雾远平面 12km → 留 40% 余量（约 7.6km）合适。 */
export function shouldReload(ground, px, pz) {
  const m = 0.40;
  const { wx0, wx1, wz0, wz1 } = ground.bounds;
  const dx = (wx1 - wx0) * m, dz = (wz1 - wz0) * m;
  return px < wx0 + dx || px > wx1 - dx || pz < wz0 + dz || pz > wz1 - dz;
}
