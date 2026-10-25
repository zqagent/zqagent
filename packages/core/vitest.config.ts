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
      {
        find: /^@zqagent\/shared\/model-capabilities$/,
        replacement: shared("model-capabilities.ts"),
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
    // 默认 5s 与本仓库若干同名等待预算（waitFor(..., 5000)）相等：条件在第 4.x 秒
    // 满足时，测试本身已经先被判超时。CI 上并发跑 1500+ 个用例、事件循环调度延迟
    // 更大，必须留出余量，否则这类「等重连/等重订阅」的用例会随机红。
    testTimeout: 15000,
  },
});
