// 3D 视景（Three.js）
//
// 拟真度按性价比排序（不是靠堆多边形）：
//   1. 正确的地平线与透视（相机在机体坐标系里跟随）
//   2. 视差（真实地形固定不动，飞机在上面飞过去）
//   3. 光照与大气（太阳方向、雾、天空梯度）
//   4. 细节（真实卫星影像、真实高程、云、舵面随飞控偏转）
//
// 坐标约定：1 单位 = 1 米，Y 向上，+X 东，+Z 南（北 = -Z）。
// 飞机机头朝 -Z，欧拉序 'YXZ'：rotation.set(pitch, -yaw, -roll)
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { buildGeoGround, shouldReload } from "./geo.js";
// 参照机状态标签要跟后果系统用【同一套阈值】。不另立一套数：
// 否则同一架飞机在仪表盘上叫“失速”、在 3D 标签上叫“正常”，演示会自相矛盾。
import { LIMITS, flightStateOf } from "../fcs/consequences.js";

// 经纬度 → 米的换算。仪表盘的幽灵机偏差和 3D 里的实际间距必须用同一组常量算，
// 否则屏幕上会同时出现两个对不上的米数。（现在只剩 3D 一处用，故不再导出。）
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320;
const FT2M = 0.3048;

const SUN_DIR = new THREE.Vector3(0.42, 0.40, -0.82).normalize();
const HORIZON = new THREE.Color("#a9c7dd").convertSRGBToLinear();
const ZENITH = new THREE.Color("#1c5f9e").convertSRGBToLinear();
const GROUND_HAZE = new THREE.Color("#8fa08a").convertSRGBToLinear();

// 机型：程序化建模（零外部资源依赖）。想换成自己的 glTF 就设 TRY_GLTF = true
// 并把 AIRCRAFT_GLB 指到你的 .glb；缩放与朝向会自动归一化。
const TRY_GLTF = false;
// 同样不能写死：子路径部署下 "/models/…" 会 404。
const AIRCRAFT_GLB = `${import.meta.env.BASE_URL}models/Cesium_Air_clean.glb`;

const GEO_ZOOM = 12;             // 影像/高程瓦片层级（12 → 单瓦片约 7.7km）
const GEO_GRID = 5;              // 5×5 瓦片 ≈ 38km，配合 12km 雾距看不到边界
const FOG_NEAR = 1200;
const FOG_FAR = 12000;

const D2R = Math.PI / 180;

// ══════════════════════════════════════════════════════════
// 程序化贴图
// ══════════════════════════════════════════════════════════
function makeHazeGroundTexture() {
  const S = 256, c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d");
  g.fillStyle = "#6d7a55"; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 40; i++) {
    g.fillStyle = ["#77835c", "#657050", "#7f8a63"][i % 3];
    g.globalAlpha = 0.5; g.fillRect(Math.random() * S, Math.random() * S, 30 + Math.random() * 60, 30 + Math.random() * 60);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeCloudTexture() {
  const S = 256, c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d");
  for (let i = 0; i < 26; i++) {
    const r = 20 + Math.random() * 60;
    const x = S / 2 + (Math.random() - 0.5) * 110, y = S / 2 + (Math.random() - 0.5) * 70;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, "rgba(255,255,255,0.75)");
    grd.addColorStop(0.5, "rgba(248,250,255,0.35)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ══════════════════════════════════════════════════════════
// 几何构造工具
// ══════════════════════════════════════════════════════════

/** 机身：用 Lathe 旋成，剖面沿机体轴，机头朝 -Z */
function makeFuselageGeo(len, rMax) {
  const pts = [], N = 20;
  for (let i = 0; i <= N; i++) {
    const t = i / N;                                   // 0 = 机头, 1 = 机尾
    let r;
    if (t < 0.20) r = rMax * Math.sqrt(Math.max(0, 1 - Math.pow((0.20 - t) / 0.20, 2))) * 0.88;
    else if (t < 0.62) r = rMax * (0.88 + 0.12 * Math.sin(((t - 0.20) / 0.42) * Math.PI));
    else r = rMax * (1 - 0.80 * Math.pow((t - 0.62) / 0.38, 1.30));
    pts.push(new THREE.Vector2(Math.max(0.02, r), -len / 2 + t * len));
  }
  const g = new THREE.LatheGeometry(pts, 22);
  g.rotateX(Math.PI / 2);        // 轴从 Y 转到 Z，机头落在 -Z
  return g;
}

/**
 * 机翼：平面形状（后掠/收尖）挤出厚度。
 * swAft > 0 表示后掠（翼尖往后挪）。
 * 右手系：+X 展向，+Z 弦向（后缘在 +Z），+Y 厚度。
 */
function makeWingGeo(rootChord, tipChord, span, swAft, thickness) {
  const rc = rootChord / 2, tc = tipChord / 2;
  const s = new THREE.Shape();
  // 形状坐标 y 与最终世界 z 反向：world_z = -shape_y
  s.moveTo(0, rc);                       // 翼根前缘
  s.lineTo(span, tc - swAft);            // 翼尖前缘
  s.lineTo(span, -tc - swAft);           // 翼尖后缘
  s.lineTo(0, -rc);                      // 翼根后缘
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: thickness, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  g.translate(0, -thickness / 2, 0);
  return g;
}

/** 铰接舵面：铰链在 z=0、x 居中，面往后(+Z)延伸 */
function makeHingeGeo(span, thickness, chord) {
  const g = new THREE.BoxGeometry(span, thickness, chord);
  g.translate(0, 0, chord / 2);
  return g;
}

/** 后缘在站位 x 处的世界 z（与 makeWingGeo 的几何一致） */
function wingTE(rootChord, tipChord, span, swAft, x) {
  const rc = rootChord / 2, tc = tipChord / 2;
  const k = x / span;
  return (rc + (tc - rc) * k) + swAft * k;
}

// ══════════════════════════════════════════════════════════
// 飞机：程序化建模 + 舵面随飞控偏转
// ══════════════════════════════════════════════════════════
function buildAircraft() {
  const G = new THREE.Group();

  const paint = new THREE.MeshStandardMaterial({ color: 0xeef1f5, metalness: 0.25, roughness: 0.42 });

  const trim = new THREE.MeshStandardMaterial({ color: 0x1f4f8f, metalness: 0.35, roughness: 0.38 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x24282e, metalness: 0.55, roughness: 0.45 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x9fd2ee, metalness: 0.1, roughness: 0.06, transparent: true, opacity: 0.45,
  });
  // 舵面比机翼略深，视觉上能看出是独立活动面。
  // 刻意【每个舵面一个材质实例】：下面要按实际偏转逐面着色，
  // 共用一个材质的话所有舵面会一起变色，根本看不出副翼的差动。
  const mkCtlMat = () => new THREE.MeshStandardMaterial({ color: 0xd8dde5, metalness: 0.3, roughness: 0.45, side: THREE.DoubleSide });
  const flapMat = mkCtlMat();          // 襟翼是静态的，不需要逐面着色，共用一个即可



  const LEN = 8.3;
  const WING_ROOT = 1.70, WING_TIP = 1.15, WING_SPAN = 5.5, WING_SW = 0.35, WING_TH = 0.17;
  const DIHEDRAL = 2.5 * D2R;
  const WING_Y = 0.02;
  const TE = (x) => wingTE(WING_ROOT, WING_TIP, WING_SPAN, WING_SW, x);
  const wingYAt = (x) => WING_Y + Math.tan(DIHEDRAL) * x;

  // 机身
  G.add(new THREE.Mesh(makeFuselageGeo(LEN, 0.62), paint));

  // 座舱玻璃
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.52, 16, 12), glass);
  canopy.scale.set(1.0, 0.85, 2.1);
  canopy.position.set(0, 0.42, -1.9);
  G.add(canopy);

  // 机翼（左右）
  const wings = [];
  for (const sign of [1, -1]) {
    const w = new THREE.Mesh(makeWingGeo(WING_ROOT, WING_TIP, WING_SPAN, WING_SW, WING_TH), paint);
    w.material = paint.clone(); w.material.side = THREE.DoubleSide;
    w.scale.x = sign;
    w.position.set(0, WING_Y, 0);
    w.rotation.z = sign * DIHEDRAL;
    G.add(w); wings.push(w);
  }

  // ── 活动舵面 ──
  const surfaces = {};

  // 副翼（外侧后缘）：正视指令 = 右滚 → 右副翼后缘向下
  // ⚠ 左右必须靠 g.position 分开（sign * xc）。只翻 scale.x 而不动位置的话，
  // 镜像只作用于几何体自身，两个舵面会叠在同一处——左边那个会跑到右侧去。
  surfaces.ail = [];
  for (const sign of [1, -1]) {
    const x0 = 3.55, span = 1.65, chord = 0.40, xc = x0 + span / 2;
    const g = new THREE.Group();
    g.name = sign > 0 ? "aileron-R" : "aileron-L";
    g.position.set(sign * xc, wingYAt(xc), TE(xc));
    g.rotation.z = sign * DIHEDRAL;
    const cm = mkCtlMat();
    const geo = makeHingeGeo(span, 0.075, chord);
    g.add(new THREE.Mesh(geo, cm));
    if (sign < 0) { g.scale.x = -1; }
    G.add(g);
    surfaces.ail.push({ g, sign, mat: cm });
  }

  // 襟翼（内侧后缘）：静态示例，放 10° 已放下（同样要靠 position 分开左右）
  surfaces.flap = [];
  for (const sign of [1, -1]) {
    const x0 = 1.25, span = 2.15, chord = 0.48, xc = x0 + span / 2;
    const g = new THREE.Group();
    g.name = sign > 0 ? "flap-R" : "flap-L";
    g.position.set(sign * xc, wingYAt(xc), TE(xc));
    g.rotation.z = sign * DIHEDRAL;
    const m = new THREE.Mesh(makeHingeGeo(span, 0.085, chord), flapMat);
    g.add(m);
    if (sign < 0) g.scale.x = -1;
    G.add(g); surfaces.flap.push({ g, sign });
  }

  // 平尾 + 升降舵
  const HS_SPAN = 1.95, HS_ROOT = 1.10, HS_TIP = 0.72, HS_SW = 0.18, HS_TH = 0.13, HS_Z = 4.05;
  const hsTE = (x) => wingTE(HS_ROOT, HS_TIP, HS_SPAN, HS_SW, x);
  for (const sign of [1, -1]) {
    const h = new THREE.Mesh(makeWingGeo(HS_ROOT, HS_TIP, HS_SPAN, HS_SW, HS_TH), paint);
    h.material = paint.clone(); h.material.side = THREE.DoubleSide;
    h.scale.x = sign; h.position.set(0, 0.28, HS_Z);
    G.add(h);
  }
  {
    const span = 1.75, chord = 0.34, xc = 0.55 + span / 2;
    const g = new THREE.Group();
    g.name = "elevator-R";
    g.position.set(xc, 0.28, HS_Z + hsTE(xc));
    const emR = mkCtlMat();
    const geR = makeHingeGeo(span, 0.06, chord);
    g.add(new THREE.Mesh(geR, emR));
    g.scale.x = 1;
    G.add(g); surfaces.elev = g; surfaces.elevMat = emR;
    // 左侧镜像
    const g2 = new THREE.Group();
    g2.name = "elevator-L";
    g2.position.set(-xc, 0.28, HS_Z + hsTE(xc));
    const emL = mkCtlMat();
    const geL = makeHingeGeo(span, 0.06, chord);
    g2.add(new THREE.Mesh(geL, emL));
    g2.scale.x = -1;
    G.add(g2); surfaces.elevL = g2; surfaces.elevLMat = emL;
  }

  // 垂尾 + 方向舵
  const FIN_H = 1.75, FIN_ROOT = 1.35, FIN_TIP = 0.85, FIN_SW = 0.45, FIN_TH = 0.13;
  {
    const shape = new THREE.Shape();
    // 竖向形状：x = 高度方向，y = 弦向（同机翼约定：world_z = -shape_y）
    shape.moveTo(0, FIN_ROOT / 2);
    shape.lineTo(FIN_H, FIN_TIP / 2 - FIN_SW);
    shape.lineTo(FIN_H, -FIN_TIP / 2 - FIN_SW);
    shape.lineTo(0, -FIN_ROOT / 2);
    shape.closePath();
    const fg = new THREE.ExtrudeGeometry(shape, { depth: FIN_TH, bevelEnabled: false });
    // 形状语义：shape.x = 高度，shape.y = 弦向，挤出 = 厚度。
    // 要把它立起来（高度→Y、弦向→Z、厚度→X），必须 rotateZ 再 rotateY。
    // 之前只写了 rotateY(90°)，结果“高度”跑到了 Z 轴 —— 垂尾没立起来，
    // 而是平躺着沿着后机身，形成一块蓝色板子（就是“机尾连接处是蓝色”的根因）。
    // 实测包围盒：错 = Y[-0.88,0.68] / Z[-1.75,0]；对 = Y[0,1.75] / Z[±0.68]。
    fg.rotateZ(Math.PI / 2);
    fg.rotateY(Math.PI / 2);
    fg.translate(-FIN_TH / 2, 0, 0);
    const fin = new THREE.Mesh(fg, trim);
    fin.material.side = THREE.DoubleSide;
    // 基准点在垂尾根部前缘；抬到后机身顶部、后缘与方向舵铰链对齐
    fin.position.set(0, 0.22, 4.27);
    G.add(fin);

    // 方向舵：铰链竖直，面往后(+Z)
    const rSpan = 1.45, rChord = 0.38;
    const rg = new THREE.Group();
    rg.name = "rudder";
    rg.position.set(0, 0.62, 4.05 + (FIN_ROOT / 2 + FIN_SW * 0.5));
    const rgGeo = makeHingeGeo(rSpan, 0.07, rChord);
    rg.add(new THREE.Mesh(rgGeo, (surfaces.rudMat = mkCtlMat())));
    rg.rotation.z = Math.PI / 2;          // 让铰链沿 Y
    G.add(rg); surfaces.rud = rg;
  }

  // 螺旋桨：2 叶离散桨叶，随转速旋转。
  // （曾试过“高转速切成运动模糊桨盘”来消除车轮效应，实际观感更差，已移除。
  //   频闪是转速远超帧率采样能力导致的，非建模错误。）
  const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.55, 12), trim);
  spinner.rotation.x = -Math.PI / 2; spinner.position.z = -LEN / 2 - 0.22;
  G.add(spinner);
  const prop = new THREE.Group();
  for (let i = 0; i < 2; i++) {
    const bl = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.35, 0.05), dark);
    bl.rotation.z = (i * Math.PI * 2) / 2;
    bl.rotation.y = 0.34;                        // 桨距角，免得看着像根平板
    prop.add(bl);
  }
  prop.position.z = -LEN / 2 - 0.12;
  G.add(prop);

  let propAngle = 0;
  function spinProp(vc, dt) {
    propAngle += (40 + (vc || 0) * 1.4) * dt;     // rad/s（@74kt 约 1371 RPM）
    prop.rotation.z = propAngle;
  }
  spinProp(0, 0);

  // 起落架
  for (const [x, z] of [[-1.15, 0.85], [1.15, 0.85], [0, -2.05]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.95, 8), dark);
    leg.position.set(x, -0.85, z); G.add(leg);
    const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.15, 14), dark);
    wh.rotation.z = Math.PI / 2; wh.position.set(x, -1.30, z); G.add(wh);
    const fair = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.55, 0.32), paint);
    fair.position.set(x, -1.05, z); G.add(fair);
  }

  // 航行灯（左红右绿尾白）
  const navL = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff2b2b }));
  navL.position.set(-WING_SPAN * 0.98, wingYAt(WING_SPAN), 0.1); G.add(navL);
  const navR = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0x2bff5a }));
  navR.position.set(WING_SPAN * 0.98, wingYAt(WING_SPAN), 0.1); G.add(navR);

  // ── 舵面偏转：把飞控指令映射成可见动作 ──
  const AIL_MAX = 20 * D2R, ELEV_MAX = 25 * D2R, RUD_MAX = 25 * D2R, FLAP_DOWN = 10 * D2R;
  // 作动器速率限制：键盘是离散 0/1 输入，ail 会从 0.054 一步跳到 -0.89，
  // 不限制的话舵面会“瞬移”，看起来就像抽撞。真实舵机本来也有速率上限。
  const ACT_RATE = 3.2;                          // rad/s
  const applied = { elev: 0, ail: 0, rud: 0 };
  const slew = (k, target, dt) => {
    const max = ACT_RATE * dt, d = target - applied[k];
    applied[k] += Math.max(-max, Math.min(max, d));
    return applied[k];
  };



  // ── 舵面着色：把【实际】偏转角映射成颜色 ──
  // 必须用实际值（rotation.x，经 slew 速率限制 + 故障权限衰减），
  // 而不是指令值 —— 注入 elevator_actuator 故障时两者会明显分叉，
  // 用指令值会出现“显示的想让它转多少、实际却没转”的撒谎情况。
  //
  // 本系统以教学为主，所以一切向“看得清”倾斜：
  //  · 中性底色用【深石板色】而不是浅灰。原来用 #d8dde5，和白机体几乎一样，
  //    往青/琥珀混色时会被洗白——这就是“颜色太浅”的根因。深色底才能让色阶拉开。
  //  · 混色走到满饱和（不乘 0.85），并用青/橙这一对高对比色。
  //  · 加 emissive 自发光：追机视角距离 ~13.5m，机体在画面里不大，
  //    而且会背光/进阴影。自发光不受光照影响，远近都读得出来。
  //
  // 为什么不能直接用 defl / 行程上限：实测正常法则下舵面普遍只用到行程的
  // 30～50%（升降舵峰值仅 29%），直接线性映射的话颜色淡得看不出来。
  // 所以加一个显示增益 + 幂次曲线，把小偏转也染上色。
  // ⚠ 这是纯视觉取舍：颜色深浅不代表舵面转到了那个比例，
  //   真实偏转角请读 surfaceTint().defl（那里是未经修饰的弧度值）。
  const CTL_BASE = new THREE.Color(0x39404a);   // 深石板灰：与白色机体的对比本身就说明“这里有舵面”
  const CTL_POS = new THREE.Color(0x00e5ff);    // 正偏：高亮青
  const CTL_NEG = new THREE.Color(0xff6a00);    // 负偏：高亮橙（与青拉开最大对比）
  const CTL_GAIN = 2.2;                         // 显示增益
  const CTL_CURVE = 0.65;                       // 幂次曲线：压低小偏转的衰减
  const CTL_GLOW = 0.55;                        // 自发光强度
  const ctlTint = (mat, norm) => {
    if (!mat) return;
    const a = Math.min(1, Math.pow(Math.min(1, Math.abs(norm) * CTL_GAIN), CTL_CURVE));
    const target = norm >= 0 ? CTL_POS : CTL_NEG;
    mat.color.copy(CTL_BASE).lerp(target, a);
    mat.emissive.copy(target).multiplyScalar(a * CTL_GLOW);   // 中位时 a≈0 → 不发光
  };
  function setControls(c, dt = 1 / 60, direct) {
    const elev = slew("elev", (c?.elev ?? 0) * ELEV_MAX, dt);
    const ail  = slew("ail",  (c?.ail  ?? 0) * AIL_MAX,  dt);
    const rud  = slew("rud",  (c?.rud  ?? 0) * RUD_MAX,  dt);
    // 正升降舵指令 = 低头 → 后缘向下（绕 X 正转即后缘下压）
    if (surfaces.elev) surfaces.elev.rotation.x = elev;
    if (surfaces.elevL) surfaces.elevL.rotation.x = elev;
    // 正副翼指令 = 右滚 → 右副翼后缘下、左副翼后缘上
    for (const { g, sign } of surfaces.ail) g.rotation.x = sign * ail;
    // 正方向舵指令 = 左偏航 → 后缘向左
    if (surfaces.rud) surfaces.rud.rotation.x = -rud;
    // 襟翼放下：两侧**同向**（都下偏）。
    // ⚠ 不能用 sign*！那是副翼的差动逻辑（副翼一上一下才能产生滚转力矩），
    // 而襟翼是增升装置，左右必须同向；用 sign* 会造成一侧上偏一侧下偏。
    for (const { g } of surfaces.flap) g.rotation.x = FLAP_DOWN;

    // 按【实际】偏转逐面着色。副翼左右差动 → 两面会呈现相反的颜色，
    // 这正是这个功能想看的东西。
    for (const { sign, mat } of surfaces.ail) ctlTint(mat, (sign * ail) / AIL_MAX);
    ctlTint(surfaces.elevMat, elev / ELEV_MAX);
    ctlTint(surfaces.elevLMat, elev / ELEV_MAX);
    ctlTint(surfaces.rudMat, -rud / RUD_MAX);
  }
  setControls({ elev: 0, ail: 0, rud: 0 });

  return { group: G, prop, setControls, surfaces, spinProp };
}

// ══════════════════════════════════════════════════════════
// 主入口
// ══════════════════════════════════════════════════════════
export function createScene3D(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  Object.assign(renderer.domElement.style, { width: "100%", height: "100%", display: "block" });
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(HORIZON.clone().multiplyScalar(1.04), FOG_NEAR, FOG_FAR);
  const camera = new THREE.PerspectiveCamera(58, 1, 0.5, 120000);

  const sun = new THREE.DirectionalLight(0xfff3e0, 2.1);
  sun.position.copy(SUN_DIR).multiplyScalar(3000);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xbfd8f0, 0x6a7350, 1.05));

  // 天空穹顶
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(60000, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        uSun: { value: SUN_DIR.clone() }, uHorizon: { value: HORIZON.clone() },
        uZenith: { value: ZENITH.clone() }, uGround: { value: GROUND_HAZE.clone() },
      },
      vertexShader: `varying vec3 vDir;
        void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uSun,uHorizon,uZenith,uGround; varying vec3 vDir;
        void main(){
          vec3 d = normalize(vDir);
          float h = clamp(d.y, -1.0, 1.0);
          vec3 col = mix(uHorizon, uZenith, pow(max(h,0.0), 0.55));
          if (h < 0.0) col = mix(uHorizon, uGround, clamp(-h*3.0, 0.0, 1.0));
          float s = max(dot(d, normalize(uSun)), 0.0);
          col += vec3(1.0,0.95,0.85) * pow(s, 240.0) * 1.8;
          col += vec3(1.0,0.92,0.78) * pow(s, 9.0) * 0.16;
          gl_FragColor = vec4(col, 1.0);
        }`,
    })
  );
  sky.frustumCulled = false;
  scene.add(sky);

  // 远景兜底地面：铺得比地理底图大得多，颜色接近雾色，
  // 这样底图边界之外是"有雾的地面"而不是虚空。
  const hazeTex = makeHazeGroundTexture();
  hazeTex.repeat.set(300, 300);
  const hazeGround = new THREE.Mesh(
    new THREE.PlaneGeometry(600000, 600000),
    new THREE.MeshBasicMaterial({ map: hazeTex, fog: true })
  );
  hazeGround.rotation.x = -Math.PI / 2;
  hazeGround.position.y = -8;
  scene.add(hazeGround);

  let geoGround = null, geoLoading = false;
  const status = { ground: "haze", aircraft: "procedural", tiles: null, geoSize: null, aircraftError: null };

  // 树木：实例化，围绕飞机循环复用
  const TREES = 480, TREE_R = 3200;
  const trees = new THREE.InstancedMesh(
    new THREE.ConeGeometry(2.4, 9, 6),
    new THREE.MeshStandardMaterial({ color: 0x2f5d2a, roughness: 1 }),
    TREES
  );
  trees.frustumCulled = false;
  const treePos = [];
  for (let i = 0; i < TREES; i++)
    treePos.push(new THREE.Vector3((Math.random() - 0.5) * TREE_R * 2, 0, (Math.random() - 0.5) * TREE_R * 2));
  scene.add(trees);

  // 云
  const CLOUDS = 70, CLOUD_R = 16000;
  const cloudTex = makeCloudTexture();
  const clouds = [];
  for (let i = 0; i < CLOUDS; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.7, depthWrite: false }));
    const s = 400 + Math.random() * 900;
    sp.scale.set(s, s * 0.5, 1);
    sp.position.set((Math.random() - 0.5) * CLOUD_R * 2, 1600 + Math.random() * 1800, (Math.random() - 0.5) * CLOUD_R * 2);
    scene.add(sp); clouds.push(sp);
  }

  // 飞机
  const aircraft = new THREE.Group();
  const ac = buildAircraft();
  aircraft.add(ac.group);
  scene.add(aircraft);

  // ── 幽灵飞机：与真机同一套几何，整体半透明 ──
  // 它吃【同样的杆位与油门】，但舵面走 DIRECT 法则（无增稳、无保护）。
  // 两机从完全相同的状态出发，此后的分离量就是「飞控对这架飞机的总体影响」。
  // 用半透明而不是给它上某种颜色：半透明是「参考/假设」的通用约定，
  // 不会和机体已有的法则色、保护色抢语义（此前给机身叠加青色发光就是栽在这上面）。
  let ghostEnabled = true;          // 无飞控参照机总开关（KeyV）
  // 指示器标签的展开/收起。收起后只留箭头（方向信息保留），
  // 标签那块文字不画 —— 它永远钉在屏幕上，讲课时会挡中间的画面。
  let indicatorExpanded = true;
  // 指示器可用区域（NDC 竖直半幅，正数）。由上层按实际 UI 面板 rect 量出来 ——
  // 面板在 #ui 层（z-index 2）盖在 3D 之上，指示器必须避开，否则屏幕上“没有它”。
  // null = 未测量，按整屏处理。
  let markerBounds = null;
  let ghostInfo = null;             // 每帧存下参照机信息；指示器推迟到相机摆好后统一摆位
  const ghostAc = buildAircraft();
  const ghostMat = new THREE.MeshStandardMaterial({
    color: 0xe4ebf4, transparent: true, opacity: 0.36,
    depthWrite: false, metalness: 0.05, roughness: 0.7,
  });
  ghostAc.group.traverse((o) => { if (o.material) o.material = ghostMat; });
  const ghost = new THREE.Group();
  ghost.add(ghostAc.group);
  scene.add(ghost);

  // ── 幽灵机 3D 指示器（锚在自机上 → 保证永远在画面里）──
  // 只画那架半透明幽灵机是不够的：追机视角始终跟着【真机】，而幽灵机会一直拉开，
  // NORMAL 开局十几秒就拉开几百米、彻底出画 —— 屏幕上什么都没有，看着就像“它不存在”。
  // 所以再给一个锚在【自机】上的指示器：半径固定，因此它永远贴在自机附近、
  // 永远不会出画；箭头指幽灵机飞走的方向，标签给真实距离与姿态差。
  // （之前放在仪表盘上是不对的：那是“低头看”，回答不了“它还在不在”。）
  // 不再用「固定半径锚在自机」的做法 —— 那样只固定了距离、没固定可见性，
  // 追机视角下参照机一旦落到自机后方，标记就会被视锥裁掉。详见 update() 里的摆位注释。
  const ghostMarker = new THREE.Group();
  const ghostArrow = new THREE.Mesh(
    // 锥尖 baked 到 +Z：后面用 lookAt 定向。
    // 注意：lookAt 会覆盖 object.rotation，所以旋转必须做在【几何】上，不能做在 object 上。
    new THREE.ConeGeometry(0.55, 1.8, 16).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xdfe8f2, transparent: true, opacity: 0.9 })
  );
  ghostMarker.add(ghostArrow);
  const gCv = document.createElement("canvas");
  gCv.width = 640; gCv.height = 170;
  const gTex = new THREE.CanvasTexture(gCv);
  const gSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: gTex, transparent: true, depthTest: false }));
  gSprite.scale.set(15, 4.0, 1);
  gSprite.position.set(0, 3.4, 0);
  ghostMarker.add(gSprite);
  ghostMarker.visible = false;
  scene.add(ghostMarker);

  // ── 坠毁标记：地面上的焦痕（配合后果系统）──
  // 注意：JSBSim 的地面是【平面】，而这里贴的是真实 DEM 地形，
  // 所以“撞山”必须由上层用本模块提供的 terrainHeightAt() 自行判定，
  // FDM 自身不会察觉到。
  const crashMark = new THREE.Mesh(
    new THREE.CircleGeometry(16, 28),
    new THREE.MeshBasicMaterial({ color: 0x140a06, transparent: true, opacity: 0.86, depthWrite: false })
  );
  crashMark.rotation.x = -Math.PI / 2;
  crashMark.visible = false;
  scene.add(crashMark);

  // ── 两机飞行状态（用于标签对照）──
  // 原来标签尾部显示的是「视野外」——那只是个实现细节（指示器被夹到屏幕边缘），
  // 对观众没有任何信息量，占着位置反而把真正要看的东西挤掉了。
  // 换成两机的【飞行状态对照】：「无飞控参照机」这个功能本身要说明的就是
  // 无保护的那架会失速/撞地，而真机有增稳与包线保护。状态差就是论点本身。
  // 阈值直接取后果系统的 LIMITS，保证与仪表盘上的结论一致。
  // 状态判定统一在 consequences.flightStateOf 里（与顶部状态带共用一份），
  // 这里不再自己算 —— 两处各写一份必然漂开。
  const flightState = flightStateOf;
  // 分隔符用中性灰：它不该跟着任何一架变色，否则会被读成第三架飞机的状态
  const SEP = { text: " ｜ ", color: "#5d6b7a" };

  let gTxt = "";
  // segs: [{ text, color }]，每段用【各自的颜色】画。
  // 自机与参照机的状态必须分开着色：两架共用一个颜色时，
  // “自机正常”会在参照机失速时一起变红，读起来像自机也出事了。
  function drawGhostLabel(l1, l2, segs) {
    const list = segs || [];
    const key = l1 + "|" + l2 + "|" + list.map((s) => s.text + s.color).join("~");
    if (key === gTxt) return;               // 只在文字真的变了才重画贴图
    gTxt = key;
    status.ghostLabel = key;                // 诊断：让“屏上到底写了什么”可被断言，不用去读画布像素
    const c = gCv.getContext("2d");
    const font = "ui-monospace, Menlo, Consolas, monospace";
    c.clearRect(0, 0, gCv.width, gCv.height);
    c.textBaseline = "middle";
    // 自动收缩字号：保证内容永远放得进画布（名字变长也不会被裁掉）
    const maxW = gCv.width - 48;
    const GAP = 26;
    let f1 = 46, f2 = 30, w1 = 0, w2 = 0, wSeg = [], w2all = 0;
    for (let i = 0; i < 16; i++) {
      c.font = `bold ${f1}px ${font}`; w1 = c.measureText(l1).width;
      c.font = `${f2}px ${font}`;      w2 = c.measureText(l2).width;
      // 量的时候必须用【真正绘制时】的字重：下面是 bold，量的时候也得是 bold，
      // 否则自动收缩会按错误的宽度判断“放得下”。
      c.font = `bold ${f2}px ${font}`; wSeg = list.map((s) => c.measureText(s.text).width);
      const segW = wSeg.reduce((a, b) => a + b, 0);
      w2all = w2 + (list.length ? GAP + segW : 0);
      if (Math.max(w1, w2all) <= maxW) break;
      f1 *= 0.93; f2 *= 0.93;
    }
    const bw = Math.max(w1, w2all) + 40;
    c.fillStyle = "rgba(6,12,20,0.78)";
    c.fillRect((gCv.width - bw) / 2, 8, bw, gCv.height - 16);

    c.textAlign = "center";
    c.font = `bold ${f1}px ${font}`; c.fillStyle = "#eef3f9";
    c.fillText(l1, gCv.width / 2, 56);

    // 第二行：左边是姿态差（暗色），右边是状态对照，每段各自着色
    const x0 = (gCv.width - w2all) / 2;
    c.textAlign = "left";
    c.font = `${f2}px ${font}`; c.fillStyle = "#9fc3e0";
    c.fillText(l2, x0, 120);
    if (list.length) {
      c.font = `bold ${f2}px ${font}`;
      let x = x0 + w2 + GAP;
      for (let i = 0; i < list.length; i++) {
        c.fillStyle = list[i].color || "#eef3f9";
        c.fillText(list[i].text, x, 120);
        x += wSeg[i];
      }
    }
    gTex.needsUpdate = true;
  }

  if (TRY_GLTF) {
    new GLTFLoader().load(AIRCRAFT_GLB, (gltf) => {
      const m = gltf.scene;
      const box = new THREE.Box3().setFromObject(m);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const inner = new THREE.Group();
      m.position.sub(center);
      m.scale.setScalar(8.3 / maxDim);
      inner.add(m);
      inner.rotation.y = size.x >= size.z ? Math.PI / 2 : 0;   // 机头 +X → -Z
      aircraft.remove(ac.group);
      aircraft.add(inner);
      status.aircraft = "gltf";
    }, undefined, (err) => {
      status.aircraftError = (err && (err.message || String(err))) || "unknown";
    });
  }

  // 相机
  const MODES = ["chase", "cockpit", "cinematic"];
  let modeIdx = 0, orbit = 0;
  const camPos = new THREE.Vector3(0, 5, 20), camTgt = new THREE.Vector3();
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  let lat0 = null, lon0 = null;
  const euler = new THREE.Euler(0, 0, 0, "YXZ");

  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function update(st, dt, ctrl, direct, ghostSt, hulls) {
    if (lat0 === null) { lat0 = st.lat; lon0 = st.lon; }
    const wx = (st.lon - lon0) * M_PER_DEG_LON * Math.cos(lat0 * Math.PI / 180);
    const wz = -(st.lat - lat0) * M_PER_DEG_LAT;
    const wy = st.h * FT2M;

    aircraft.position.set(wx, wy, wz);
    euler.set(
      THREE.MathUtils.degToRad(st.theta),
      -THREE.MathUtils.degToRad(st.psi),
      -THREE.MathUtils.degToRad(st.phi)
    );
    aircraft.quaternion.setFromEuler(euler);

    // 幽灵机摆位：与真机共用同一个原点(lat0/lon0)与同一套映射，
    // 否则两机的世界坐标不可比，“分离量”就没有意义。
    if (ghostSt && ghostEnabled) {
      ghost.visible = true;
      ghost.position.set(
        (ghostSt.lon - lon0) * M_PER_DEG_LON * Math.cos(lat0 * Math.PI / 180),
        ghostSt.h * FT2M,
        -(ghostSt.lat - lat0) * M_PER_DEG_LAT
      );
      euler.set(
        THREE.MathUtils.degToRad(ghostSt.theta),
        -THREE.MathUtils.degToRad(ghostSt.psi),
        -THREE.MathUtils.degToRad(ghostSt.phi)
      );
      ghost.quaternion.setFromEuler(euler);
      ghostAc.setControls(direct ?? { elev: 0, ail: 0, rud: 0 }, dt, direct);   // 幽灵机自己的舵面也照 DIRECT 动

      // 指示器的实际摆位推迟到相机摆好之后再算：必须用【当帧】相机矩阵，
      // 否则会慢一帧。这里只把参照机信息存下来。
      const gDist = ghost.position.distanceTo(aircraft.position);
      ghostInfo = gDist > 1e-3 ? {
        dist: gDist,
        dTheta: st.theta - ghostSt.theta,
        dPhi: st.phi - ghostSt.phi,
        dH: st.h - ghostSt.h,
      } : null;
    } else {
      ghost.visible = false;
      ghostInfo = null;
    }

    ac.setControls(ctrl, dt, direct);                        // ← 舵面随飞控偏转（并更新幽灵参考）
    ac.spinProp(st.vc, dt);                                  // ← 螺旋桨随转速旋转

    // 真实地理底图
    if (!geoGround && !geoLoading) {
      geoLoading = true;
      buildGeoGround(lat0, lon0, { zoom: GEO_ZOOM, grid: GEO_GRID })
        .then((g) => {
          geoGround = g;
          scene.add(g.mesh);
          hazeGround.position.y = -8;
          status.ground = "geo";
          status.tiles = g.tiles;
          status.geoSize = [Math.round(g.sizeX / 1000), Math.round(g.sizeZ / 1000)];
        })
        .catch((err) => { status.ground = "haze(failed)"; status.aircraftError = err?.message || String(err); })
        .finally(() => { geoLoading = false; });
    } else if (geoGround && !geoLoading && shouldReload(geoGround, wx, wz)) {
      geoLoading = true;
      const old = geoGround;
      buildGeoGround(lat0, lon0, { zoom: GEO_ZOOM, grid: GEO_GRID })
        .then((g) => { geoGround = g; scene.add(g.mesh); scene.remove(old.mesh); old.dispose(); status.tiles = g.tiles; })
        .catch(() => { })
        .finally(() => { geoLoading = false; });
    }

    const groundY = (x, z) => (geoGround ? geoGround.heightAt(x, z) : 0);

    // 树木
    const mtx = new THREE.Matrix4();
    for (let i = 0; i < TREES; i++) {
      const tp = treePos[i];
      if (tp.x - wx > TREE_R) tp.x -= TREE_R * 2;
      else if (tp.x - wx < -TREE_R) tp.x += TREE_R * 2;
      if (tp.z - wz > TREE_R) tp.z -= TREE_R * 2;
      else if (tp.z - wz < -TREE_R) tp.z += TREE_R * 2;
      mtx.makeTranslation(tp.x, groundY(tp.x, tp.z) + 4, tp.z);
      trees.setMatrixAt(i, mtx);
    }
    trees.instanceMatrix.needsUpdate = true;
    trees.visible = wy - groundY(wx, wz) < 2600;

    // 云
    for (const c of clouds) {
      if (c.position.x - wx > CLOUD_R) c.position.x -= CLOUD_R * 2;
      else if (c.position.x - wx < -CLOUD_R) c.position.x += CLOUD_R * 2;
      if (c.position.z - wz > CLOUD_R) c.position.z -= CLOUD_R * 2;
      else if (c.position.z - wz < -CLOUD_R) c.position.z += CLOUD_R * 2;
    }

    // 相机
    // 注：相机追随用 camPos.lerp(target, 1 - pow(K, dt))，这个幂函数形式**本身
    // 就是帧率无关的** —— 实测间距抖动仅 0.16m（见 experiments/camera-jitter.mjs）。
    // 试过把 dt 做夹紧+EMA 平滑，反而恶化到 0.91m：EMA 让 dt 滞后于真实值，
    // 掉帧时追上不足、之后过冲，自己制造振荡。所以这里保持原始 dt。
    const mode = MODES[modeIdx];
    // 座舱视角要“看不到自机”：相机在机体内部时，机头/机翼/座舱罩会糊在画面上挡视线。
    // aircraft 是顶层组（程序化机体或 GLB 二选一），整组隐藏即可。
    aircraft.visible = mode !== "cockpit";
    status.camMode = mode;        // 诊断用
    status.ownShip = aircraft.visible;
    let bodyUp = false;   // 座舱视角必须让“上”跟着机体，否则滚转时地平线不跟着倾斜
    if (mode === "chase") {
      tmp.set(0, 3.4, 13.5).applyQuaternion(aircraft.quaternion).add(aircraft.position);
      tmp2.set(0, 1.2, -8).applyQuaternion(aircraft.quaternion).add(aircraft.position);
      camPos.lerp(tmp, 1 - Math.pow(0.0015, dt));
      camTgt.lerp(tmp2, 1 - Math.pow(0.0015, dt));
    } else if (mode === "cockpit") {
      // 飞行员眼位：座舱内偏前偏上，视线朝正前方（机体 -Z）。
      // 不做插值——座舱里相机必须刚性跟随机体，插值会产生“镜头游泳”和延迟。
      camPos.set(0, 0.62, -1.75).applyQuaternion(aircraft.quaternion).add(aircraft.position);
      camTgt.set(0, 0.62, -60).applyQuaternion(aircraft.quaternion).add(aircraft.position);
      bodyUp = true;
    } else {
      // 环绕
      orbit += dt * 0.22;
      const r = 24;
      tmp.set(Math.cos(orbit) * r, 6, Math.sin(orbit) * r).add(aircraft.position);
      camPos.lerp(tmp, 1 - Math.pow(0.002, dt));
      camTgt.lerp(aircraft.position, 1 - Math.pow(0.002, dt));
    }
    // 注意：up 必须在 lookAt **之前**设——lookAt 会立即用当时的 up 算朝向，
    // 设在后面这一帧不生效。原代码是“先 lookAt 再 set up”，只因恒为 (0,1,0) 才没暴露。
    if (bodyUp) camera.up.set(0, 1, 0).applyQuaternion(aircraft.quaternion);
    else camera.up.set(0, 1, 0);
    status.camUp = [+camera.up.x.toFixed(3), +camera.up.y.toFixed(3), +camera.up.z.toFixed(3)];
    status.bank = +st.phi.toFixed(2);
    camera.position.copy(camPos);
    camera.lookAt(camTgt);
    sky.position.copy(camera.position);
    hazeGround.position.x = wx; hazeGround.position.z = wz;

    // ── 无飞控参照机 指示器：在【相机空间】里算，并夹进视锥 ──
    // 旧做法是「锚在自机上、固定 12m 半径」，只固定了距离、没固定可见性：
    // 追机相机在自机后方约 13.5m，一旦参照机落到自机后方，方向就指向背后，
    // 标记会落到相机脚下乃至身后，被视锥裁掉 —— 屏幕上什么都没有。
    // 现在：把目标方向换算进相机空间，按视锥半角夹到边界内，再放到距相机固定深度处。
    // 于是无论参照机飞到哪，指示器都不会出画，且标签大小恒定（不会远到看不清）。
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    if (ghostInfo && ghostEnabled && ghostInfo.dist > 20) {
      const vCam = ghost.position.clone().applyMatrix4(camera.matrixWorldInverse);
      if (vCam.z > -0.5) vCam.z = -0.5;              // 在正后方时推到前方，避免除零/反向
      const halfV = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
      const halfH = halfV * camera.aspect;
      const DEPTH = 18;                               // 距相机的固定深度
      const PAD = 0.03, FIT = 0.46;                   // 边距 / 允许占用的 NDC 半幅

      // 标签世界尺寸：默认 15m 宽；若视口太窄放不下就等比缩小。
      // 不做这一步的话，窄视口下标签本身就比屏幕宽，怎么夹都会溢出。
      let LW = 15, LH = LW * (gCv.height / gCv.width);
      const upOff = () => LH * 0.85;                  // 标签抬到箭头上方
      const needW = (LW / 2) / (DEPTH * halfH);
      const needH = (upOff() + LH / 2) / (DEPTH * halfV);
      const k = Math.max(needW / FIT, needH / FIT, 1);
      if (k > 1) { LW /= k; LH /= k; }
      gSprite.scale.set(LW, LH, 1);
      gSprite.position.set(0, upOff(), 0);
      gSprite.visible = indicatorExpanded;   // 收起：只留箭头，标签不画

      // 夹紧边界：把【标签的半个外延】也算进去。
      // 之前只夹中心点（limX = 0.8），而标签自身还向两侧各伸 ~0.42 NDC →
      // 0.8 + 0.42 = 1.22 > 1，所以贴到左右边缘时会有一半在屏幕外。
      // 收起时标签不画，就不该再为它预留边距 —— 否则箭头会被白白挡在屏幕内侧。
      const hw = indicatorExpanded ? (LW / 2) / (DEPTH * halfH) : 0;          // 标签在 NDC 里的半宽
      const hh = indicatorExpanded ? (upOff() + LH / 2) / (DEPTH * halfV) : 0; // 半高（含向上偏移）
      const limX = Math.max(0.05, 1 - hw - PAD);
      // 竖直【上下界分开】：UI 面板压在屏幕下方（座舱视角的仪表板、追机视角的时间历程栏），
      // 且盖在 3D 之上。用对称边界的话指示器会被摆到面板底下 ——
      // 实测：座舱视角下仪表板上沿约占屏幕下方 37%，指示器落在那里就完全看不见。
      const limYBase = Math.max(0.05, 1 - hh - PAD);
      const limYup = Math.max(0.05, Math.min(limYBase, markerBounds ? markerBounds.up : 1));
      const limYdn = Math.max(0.05, Math.min(limYBase, markerBounds ? markerBounds.down : 1));

      const tx = vCam.x / (-vCam.z), ty = vCam.y / (-vCam.z);
      const limYv = ty >= 0 ? limYup : limYdn;
      const s = Math.max(Math.abs(tx) / (limX * halfH), Math.abs(ty) / (limYv * halfV), 1);
      const off = s > 1.001;                          // 被夹到边缘 = 参照机在视野外
      ghostMarker.visible = true;
      ghostMarker.position.set((tx / s) * DEPTH, (ty / s) * DEPTH, -DEPTH)
        .applyMatrix4(camera.matrixWorld);
      // 只转箭头，不转 marker：marker 一转，子节点标签会跟着倾斜，
      // 上面按屏幕轴算的外延就不准了。
      ghostArrow.lookAt(ghost.position);
      ghostArrow.material.opacity = off ? 1.0 : 0.72;

      // 诊断：ndc 是指示器中心，edgeMax 是「中心+标签外延」的最外沿，
      // 后者 ≤ 1 才算真正不出画。
      const ndcX = (tx / s) / halfH, ndcY = (ty / s) / halfV;
      status.ghostMarker = {
        ndc: [+ndcX.toFixed(3), +ndcY.toFixed(3)],
        labelHalfNdc: [+hw.toFixed(3), +hh.toFixed(3)],
        limY: [+limYup.toFixed(3), +limYdn.toFixed(3)],
        edgeMax: [+(Math.abs(ndcX) + hw).toFixed(3), +(Math.abs(ndcY) + hh).toFixed(3)],
        labelWorld: [+LW.toFixed(2), +LH.toFixed(2)],
        off,
        dist: +ghostInfo.dist.toFixed(1),
        camZ: +vCam.z.toFixed(1),
      };
      const sg = (v, n = 1) => (v >= 0 ? "+" : "") + v.toFixed(n);
      const d = ghostInfo.dist;
      // AGN 用与自机同一套 groundY，保证两机的“离地”可比
      const ghostAgl = ghost.position.y - groundY(ghost.position.x, ghost.position.z);
      const ownAgl = aircraft.position.y - groundY(aircraft.position.x, aircraft.position.z);
      const sOwn = flightState(st, ownAgl, hulls?.own?.hull, hulls?.own?.crashed);
      const sGho = flightState(ghostSt, ghostAgl, hulls?.ghost?.hull, hulls?.ghost?.crashed);
      // 一机的段落 = 名字 + 当前状态 [+ “ · ” + 累积损伤]
      const mk = (s, prefix) => {
        if (!s) return [];
        const out = [{ text: prefix + s.text, color: s.color }];
        if (s.dmg) out.push({ text: " · ", color: "#5d6b7a" }, s.dmg);
        return out;
      };
      // 两机状态【各自着色】：自机的颜色只说明自机，参照机的颜色只说明参照机。
      // （之前整段共用一个颜色、取更严重的一方，会让“自机 正常”也被染红。）
      const ownSegs = mk(sOwn, "自机 "), ghoSegs = mk(sGho, "参照机 ");
      const segs = (ownSegs.length && ghoSegs.length) ? [...ownSegs, SEP, ...ghoSegs] : [];
      drawGhostLabel(
        `无飞控参照机  ${d < 1000 ? d.toFixed(0) + " m" : (d / 1000).toFixed(2) + " km"}`,
        `Δθ${sg(ghostInfo.dTheta)}°  Δφ${sg(ghostInfo.dPhi)}°  Δh${sg(ghostInfo.dH, 0)}ft`,
        segs
      );
    } else {
      ghostMarker.visible = false;
      status.ghostMarker = null;
    }

    renderer.render(scene, camera);
  }

  resize();
  return {
    update, resize,
    nextMode: () => { modeIdx = (modeIdx + 1) % MODES.length; return MODES[modeIdx]; },
    getMode: () => MODES[modeIdx],
    status,
    /** 幽灵机总开关（教学时可能想先藏起来，只讲真机） */
    setGhostVisible: (v) => { ghostEnabled = !!v; if (!ghostEnabled) ghost.visible = false; return ghostEnabled; },
    getGhostVisible: () => ghostEnabled,
    /** 参照机指示器标签的展开/收起（收起后只留小箭头） */
    setIndicatorExpanded: (v) => { indicatorExpanded = !!v; if (!indicatorExpanded) gSprite.visible = false; return indicatorExpanded; },
    getIndicatorExpanded: () => indicatorExpanded,
    /** 指示器可用区域（NDC 竖直半幅，正数）。上层按实际 UI 面板量，避开遮挡。 */
    setMarkerBounds: (b) => { markerBounds = b && b.up > 0 && b.down > 0 ? b : null; },

    /** 查某经纬度处的【真实地形】高度（米，MSL）。地形尚未就绪时返回 null。
     *  上层的后果系统靠它判定撞地 —— JSBSim 的 h-agl 是相对平面地面的，
     *  在这张真实地形图上不可用。 */
    terrainHeightAt: (lat, lon) => {
      if (!geoGround || lat0 === null) return null;
      const x = (lon - lon0) * M_PER_DEG_LON * Math.cos(lat0 * Math.PI / 180);
      const z = -(lat - lat0) * M_PER_DEG_LAT;
      const h = geoGround.heightAt(x, z);
      return Number.isFinite(h) ? h : null;
    },
    /** 在坠毁点画出焦痕 */
    markCrash: (lat, lon) => {
      if (lat0 === null) return false;
      const x = (lon - lon0) * M_PER_DEG_LON * Math.cos(lat0 * Math.PI / 180);
      const z = -(lat - lat0) * M_PER_DEG_LAT;
      const gy = geoGround ? geoGround.heightAt(x, z) : 0;
      crashMark.position.set(x, gy + 0.08, z);   // 稍抬避免与地形 z-fighting
      crashMark.visible = true;
      return true;
    },
    clearCrash: () => { crashMark.visible = false; },
    /** 诊断用：幽灵机指示器的位置与半径。
     *  半径应恒等于固定显示半径 —— 这正是“幽灵机飞多远它都不会出画”的保证。 */
    debugGhostMarker: () => ({
      visible: ghostMarker.visible,
      r: +ghostMarker.position.distanceTo(aircraft.position).toFixed(3),
    }),
    /** 诊断用：真机与幽灵机的世界坐标。两者间距 = 飞控的总体影响（米）。 */
    debugGhost: () => ({
      live: aircraft.position.toArray().map((v) => +v.toFixed(2)),
      ghost: ghost.position.toArray().map((v) => +v.toFixed(2)),
      sep: +aircraft.position.distanceTo(ghost.position).toFixed(2),
      visible: ghost.visible,
    }),
    /** 幽灵材质：供自动化把透明度设成 0 做“开/关差分”，从而量化幽灵的可见性 */

    /** 诊断用：各舵面的【实际】偏转角（rad）与当前着色，供自动化断言。
     *  注意这里读的是 rotation.x（经过 slew 速率限制 + 故障权限衰减的真实值），
     *  不是飞控的指令值 —— 两者在作动器故障下会分叉，这正是要验证的点。 */
    surfaceTint: () => {
      const hex = (m) => (m ? "#" + m.color.getHexString() : null);
      const ailL = ac.surfaces.ail.find((s) => s.sign < 0);
      const ailR = ac.surfaces.ail.find((s) => s.sign > 0);
      const rd = (g) => (g ? +g.rotation.x.toFixed(4) : null);
      return {
        ailL: { defl: rd(ailL?.g), color: hex(ailL?.mat) },
        ailR: { defl: rd(ailR?.g), color: hex(ailR?.mat) },
        elev: { defl: rd(ac.surfaces.elev), color: hex(ac.surfaces.elevMat) },
        elevL: { defl: rd(ac.surfaces.elevL), color: hex(ac.surfaces.elevLMat) },
        rud: { defl: rd(ac.surfaces.rud), color: hex(ac.surfaces.rudMat) },
      };
    },
    /** 诊断用：各操纵面在**机体坐标系**下的中心与尺寸（查左右装反 / 重叠 / 不对称）。
     *  必须用逆矩阵把飞机自身姿态剔除，否则量到的是世界坐标，姿态会掩盖镜像错误。 */
    debugSurfaces: () => {
      const out = {};
      ac.group.updateWorldMatrix(true, true);
      const inv = new THREE.Matrix4().copy(ac.group.matrixWorld).invert();
      ac.group.traverse((o) => {
        if (!o.name || !/^(aileron|flap|elevator|rudder)/.test(o.name)) return;
        const b = new THREE.Box3().setFromObject(o);
        const c = b.getCenter(new THREE.Vector3()).applyMatrix4(inv);   // → 机体坐标
        const s = b.getSize(new THREE.Vector3());
        const r3 = (v) => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];
        out[o.name] = {
          bodyCenter: r3(c),
          size: r3(s),
          hingeY: +o.position.y.toFixed(3),
          // 后缘相对铰链的垂直偏移：<0 = 后缘下偏，>0 = 后缘上偏。
          // 测镜像对称要同时比 x 和 deflY，只看 x 会漏掉“一侧上偏一侧下偏”。
          deflY: +(c.y - o.position.y).toFixed(4),
        };
      });
      return out;
    },
    dispose: () => { geoGround?.dispose(); renderer.dispose(); container.innerHTML = ""; },
  };
}
