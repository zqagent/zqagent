import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const shared = (p: string) =>
  fileURLToPath(new URL(`../shared/src/${p}`, import.meta.url));

// 测试直接解析 @zqagent/shared 到源码（免先构建），子路径须排在根路径之前。
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@zqagent\/shared\/fleet$/, replacement: shared("fleet.ts") },
      { find: /^@zqagent\/shared\/secrets$/, replacement: shared("secrets.ts") },
      {
        find: /^@zqagent\/shared\/approval-view$/,
        replacement: shared("approval-view.ts"),
      },
      {
        find: /^@zqagent\/shared\/llm-presets$/,
        replacement: shared("llm-presets.ts"),
      },
      { find: /^@zqagent\/shared\/notify$/, replacement: shared("notify/index.ts") },
      { find: /^@zqagent\/shared\/hub-api$/, replacement: shared("hub-api.ts") },
      { find: /^@zqagent\/shared\/wire$/, replacement: shared("wire/index.ts") },
      { find: /^@zqagent\/shared\/wire\/node$/, replacement: shared("wire/node.ts") },
      { find: /^@zqagent\/shared$/, replacement: shared("index.ts") },
    ],
  },
  test: {
    // 隔离 LLM 配置，避免测试写开发者本机的 ~/.config/zqagent
    setupFiles: ["./test/setup.ts"],
  },
});
