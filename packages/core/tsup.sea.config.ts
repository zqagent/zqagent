import { resolve } from "node:path";
import { readFileSync } from "fs";
import { defineConfig } from "tsup";

/** 构建期注入版本（发布产物 `zqagent --version` / 节点信息用） */
const PKG_VERSION = (
  JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as { version: string }
).version;
import { DEBUG_BOOTSTRAP_JS } from "./scripts/debug_bootstrap.mjs";

/**
 * CLI 单文件（Node SEA）专用构建
 *
 * 与 tsup.config.ts 的区别：不做任何 external、只输出一个 CJS 文件。
 * 原因：SEA blob 内只允许 require Node 内置模块，所有第三方依赖
 * （openai / dotenv / socks-proxy-agent …）必须全部打进同一个文件。
 *
 * 产物：dist/sea/zqagent.cjs，由 scripts/build_cli_binary.mjs 注入到
 * 目标平台的 node 可执行文件中，得到免装 Node 的单文件 CLI。
 */
export default defineConfig({
  define: {
    "process.env.ZQAGENT_VERSION": JSON.stringify(PKG_VERSION),
    // 标记单文件形态：自动更新只在这种形态下允许替换自身
    "process.env.ZQAGENT_SEA": JSON.stringify("1"),
  },
  entry: { zqagent: "src/cli/index.ts" },
  format: ["cjs"],
  platform: "node",
  target: "node20",
  dts: false,
  clean: false, // 不能清 dist/：常规构建的产物也在里面
  sourcemap: false,
  splitting: false,
  shims: true,
  noExternal: [/.*/],
  outDir: "dist/sea",
  // 诊断模式（--debug）的启动引导：注入到 bundle 顶部，早于任何模块代码。
  // 单文件产物崩溃在模块初始化阶段时，这是唯一能留下证据的位置。
  banner: { js: DEBUG_BOOTSTRAP_JS },
  // 把未安装的可选依赖 `encoding`（node-fetch@2 顶层 require）alias 到空桩，
  // 让 esbuild 内联，避免 SEA 运行时向其 require 请求非内置模块而告警。
  // 详见 scripts/stubs/encoding.cjs。
  esbuildOptions(options) {
    options.alias = {
      ...options.alias,
      encoding: resolve(process.cwd(), "scripts/stubs/encoding.cjs"),
    };
  },
});
