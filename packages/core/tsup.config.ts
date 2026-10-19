import { readFileSync } from "fs";
import { defineConfig } from "tsup";

/** 构建期注入版本（发布产物 `zqagent --version` / 节点信息用） */
const PKG_VERSION = (
  JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as { version: string }
).version;

export default defineConfig({
  define: {
    "process.env.ZQAGENT_VERSION": JSON.stringify(PKG_VERSION),
    // npm 包形态没有 libc 变体：固定为普通清单键（macos-arm64 / linux-x64 …）
    "process.env.ZQAGENT_LIBC_VARIANT": JSON.stringify(""),
  },
  // 多入口 — 匹配 package.json exports 的每个子路径
  entry: {
    index: "src/index.ts",
    "cli/index": "src/cli/index.ts",
    "server/index": "src/server/index.ts",
    "tools/files": "src/tools/files.ts",
    "tools/shell": "src/tools/shell.ts",
    "tools/search": "src/tools/search.ts",
    "tools/web": "src/tools/web.ts",
    "tools/git": "src/tools/git.ts",
    "tools/diff": "src/tools/diff.ts",
    "tools/todo": "src/tools/todo.ts",
    "tools/ask": "src/tools/ask.ts",
    "tools/plan": "src/tools/plan.ts",
    "tools/directories": "src/tools/directories.ts",
    "tools/explore": "src/tools/explore.ts",
    "tools/media": "src/tools/media.ts",
  },
  format: ["esm", "cjs"],
  dts: { resolve: true },
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: true,
  // @zqagent/shared 必须内联：它 private 且不发包，若留作外部依赖，发布出去的
  // CLI 一运行就 MODULE_NOT_FOUND（hub 的镜像构建同理，见 Dockerfile.hub）。
  noExternal: [/^@zqagent\/shared(\/|$)/],
  external: [
    "openai",
    "dotenv",
    "dotenv/config",
  ],
  outDir: "dist",
});
