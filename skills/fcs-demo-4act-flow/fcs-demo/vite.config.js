import { defineConfig } from "vite";

// 两种部署形态，base 必须分开：
//   dev   —— localhost:5173/ 根路径（保持原有开发习惯不变）
//   build —— 服务器上挂在 https://<host>/fcs-demo/ 子路径下
// 源码里原先写死的 "/data/…" 与 "/models/…" 在子路径下会 404，
// 已改为基于 import.meta.env.BASE_URL（dev 下它仍是 "/"，行为不变）。
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/fcs-demo/" : "/",
  // WASM 包需要禁用依赖预打包，否则二进制定位会失败
  optimizeDeps: { exclude: ["@0x62/jsbsim-wasm"] },
  server: { port: 5173, host: true },
  build: { target: "esnext" },
}));
