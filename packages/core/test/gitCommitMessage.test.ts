/**
 * AI 生成 Git 提交说明
 *
 * 覆盖：模型输出清理、暂存区差异进入提示词、无变更 / 未配置 LLM 的错误路径。
 * OpenAIProvider 被 mock，测试不访问网络。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cleanCommitMessage,
  generateGitCommitMessage,
} from "../src/server/gitCommitMessage.js";
import { Store } from "../src/server/store.js";
import type { TenantConfig } from "../src/server/types.js";

const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }));

vi.mock("../src/providers/OpenAIProvider.js", () => ({
  OpenAIProvider: class {
    chat = chatMock;
  },
}));

let root: string;
let repo: string;
let store: Store;
let prevEnvKey: string | undefined;

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function tenant(patch: Partial<TenantConfig> = {}): TenantConfig {
  return {
    id: "p1",
    apiKey: "k1",
    model: "test-model",
    provider: { apiKey: "test-key" },
    workspaceRoot: repo,
    ...patch,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-gitmsg-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ow-gitmsg-repo-"));
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "tester"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(["add", "."]);
  git(["commit", "-qm", "init"]);

  store = new Store(root, { llmConfigFile: path.join(root, "llm.json") });
  chatMock.mockReset();
  prevEnvKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  if (prevEnvKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevEnvKey;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("cleanCommitMessage", () => {
  it("去掉代码块、前缀与包裹引号，只保留首行", () => {
    expect(cleanCommitMessage("```\ncommit message: feat(core): 新增功能\n```")).toBe(
      "feat(core): 新增功能",
    );
    expect(cleanCommitMessage("“fix(portal): 修复按钮”\n\n详细说明")).toBe(
      "fix(portal): 修复按钮",
    );
    expect(cleanCommitMessage("   ")).toBe("");
  });
});

describe("generateGitCommitMessage", () => {
  it("把暂存区差异交给模型并返回清理后的说明", async () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    git(["add", "a.txt"]);
    chatMock.mockResolvedValue("```\ncommit message: feat(core): 新增 AI 提交说明\n\n细节\n```");

    const message = await generateGitCommitMessage({
      store,
      tenant: tenant(),
      workspaceRoot: repo,
    });

    expect(message).toBe("feat(core): 新增 AI 提交说明");
    expect(chatMock).toHaveBeenCalledTimes(1);
    const [, messages, , ,] = chatMock.mock.calls[0]!;
    const user = (messages as Array<{ role: string; content: string }>).at(-1);
    expect(user?.role).toBe("user");
    expect(user?.content).toContain("已暂存");
    expect(user?.content).toContain("+two");
  });

  it("没有变更时报 no_changes", async () => {
    await expect(
      generateGitCommitMessage({ store, tenant: tenant(), workspaceRoot: repo }),
    ).rejects.toMatchObject({ code: "no_changes" });
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("未配置 LLM 时报 llm_not_configured", async () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    git(["add", "a.txt"]);

    await expect(
      generateGitCommitMessage({
        store,
        tenant: tenant({ provider: {}, llmProviders: [], activeProviderId: "" }),
        workspaceRoot: repo,
      }),
    ).rejects.toMatchObject({ code: "llm_not_configured" });
    expect(chatMock).not.toHaveBeenCalled();
  });
});
