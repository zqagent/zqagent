import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    fleet: "src/fleet.ts",
    secrets: "src/secrets.ts",
    "approval-view": "src/approval-view.ts",
    "llm-presets": "src/llm-presets.ts",
    "hub-api": "src/hub-api.ts",
    "notify/index": "src/notify/index.ts",
    "wire/index": "src/wire/index.ts",
    "wire/node": "src/wire/node.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  // 第三方运行期依赖不打进 bundle（由使用方 node_modules 提供）
  external: ["nodemailer", "node-fetch"],
});
