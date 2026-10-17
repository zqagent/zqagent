/**
 * explore 子代理执行过程可见性测试
 *
 * explore 子代理在自己的上下文里运行，它的事件流默认被工具函数吞掉
 * （只留最终报告）。本文件验证：注入 hook / hookFactory 后，子代理的
 * 工具活动（read_file 等）会回调给调用方，SubagentHook 会把它缩进打印
 * 到终端；不注入时行为与旧版一致（静默且不报错）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ToolRegistry,
  EventType,
  SubagentHook,
  registerExploreTool,
} from "../src/index.js";
import { ConsoleHook, displayWidth } from "../src/engine/ConsoleHook.js";
import { buildExplorerEngine, makeExploreTool } from "../src/tools/explore.js";
import type {
  StreamChunk,
  TokenUsage,
  ProviderClient,
  WsEvent,
  EngineHook,
} from "../src/index.js";

const usage: TokenUsage = { input: 5, output: 3, cacheRead: 0, cacheWrite: 0 };

/** 脚本化 Provider：按调用次数依次返回预设的 chunk 序列 */
class ScriptedProvider implements ProviderClient {
  calls = 0;
  constructor(private script: StreamChunk[][]) {}

  async stream(): Promise<AsyncIterable<StreamChunk>> {
    const chunks = this.script[this.calls++] ?? [];
    return (async function* () {
      for (const c of chunks) yield c;
    })();
  }
}

/** 文本型最终 chunk */
function textChunk(content: string, finishReason = "stop"): StreamChunk {
  return { content, reasoning: null, toolCalls: null, usage: null, finishReason };
}

/** 工具调用型最终 chunk */
function toolChunk(toolCalls: StreamChunk["toolCalls"]): StreamChunk {
  return {
    content: null,
    reasoning: null,
    toolCalls,
    usage,
    finishReason: "tool_calls",
  };
}

/** 子代理「读文件 → 出报告」两轮脚本 */
function readThenReport(file: string, report: string): ScriptedProvider {
  return new ScriptedProvider([
    [toolChunk([{ id: "call_1", name: "read_file", arguments: { path: file } }])],
    [textChunk(report)],
  ]);
}

/** 记录子代理回调顺序的钩子 */
function recorder() {
  const events: string[] = [];
  const hook: EngineHook = {
    onTurnStart: (input) => events.push(`start:${input}`),
    onToolStarted: (name) => events.push(`tool:start:${name}`),
    onToolFinished: (name, status) => events.push(`tool:finish:${name}:${status}`),
    onTurnEnd: (status) => events.push(`end:${status}`),
  };
  return { events, hook };
}

/** 收集一轮 Turn 的事件 */
async function collect(events: AsyncIterable<WsEvent>): Promise<WsEvent[]> {
  const out: WsEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ow-explore-"));
  fs.writeFileSync(path.join(workspace, "a.txt"), "line1\nline2");
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("explore 子代理的执行过程", () => {
  it("注入 hook 后子代理的工具活动会回调给调用方", async () => {
    const rec = recorder();
    const engine = buildExplorerEngine({
      workspace,
      provider: readThenReport("a.txt", "报告：a.txt 有两行"),
      model: "test-model",
      hook: rec.hook,
    });

    const events = await collect(engine.run("读 a.txt 并汇报"));

    expect(rec.events).toEqual([
      "start:读 a.txt 并汇报",
      "tool:start:read_file",
      "tool:finish:read_file:ok",
      "end:completed",
    ]);
    expect(events[events.length - 1]!.data.status).toBe("completed");
  });

  it("不注入 hook 时保持静默，且不影响运行结果", async () => {
    const engine = buildExplorerEngine({
      workspace,
      provider: readThenReport("a.txt", "报告：a.txt 有两行"),
      model: "test-model",
    });

    const events = await collect(engine.run("读 a.txt 并汇报"));
    const end = events[events.length - 1]!;

    expect(end.type).toBe(EventType.TURN_END);
    expect(end.data.status).toBe("completed");
  });

  it("makeExploreTool 用 hookFactory 为每次调用生成独立钩子", async () => {
    const created: ReturnType<typeof recorder>[] = [];
    const explore = makeExploreTool({
      workspace,
      provider: readThenReport("a.txt", "报告：a.txt 有两行"),
      model: "test-model",
      hookFactory: () => {
        const rec = recorder();
        created.push(rec);
        return rec.hook;
      },
    });

    const result = await explore({ task: "读 a.txt" });

    expect(result.error).toBeUndefined();
    expect(String(result.report)).toContain("报告");
    // 每次调用一个新实例，避免并发 explore 共用渲染器串状态
    expect(created).toHaveLength(1);
    expect(created[0]!.events).toContain("tool:start:read_file");
    expect(created[0]!.events[created[0]!.events.length - 1]).toBe("end:completed");
  });

  it("registerExploreTool 把 hookFactory 透传到每次 explore 调用", async () => {
    const rec = recorder();
    const registry = new ToolRegistry();
    registerExploreTool(registry, {
      workspace,
      provider: readThenReport("a.txt", "报告：a.txt 有两行"),
      model: "test-model",
      hookFactory: () => rec.hook,
    });

    const result = (await registry.execute("explore", {
      task: "读 a.txt",
    })) as Record<string, unknown>;

    expect(String(result.report)).toContain("报告");
    expect(rec.events).toContain("tool:finish:read_file:ok");
  });
});

describe("SubagentHook 渲染", () => {
  it("把子代理的工具活动缩进打印到终端", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const hook = new SubagentHook();
      hook.onTurnStart("研究 CLI 的输出链路");
      hook.onToolProposed("read_file", { path: "a.txt" });
      hook.onToolStarted("read_file");
      hook.onToolFinished("read_file", "ok", "line1 line2");
      hook.onTurnEnd("completed", 1, []);
      const lines = spy.mock.calls.map((c) => String(c[0]));

      expect(lines).toHaveLength(4);
      expect(lines[0]).toMatch(/^ {3}┌─ explore#\d+ /);
      expect(lines[0]).toContain("研究 CLI 的输出链路");
      expect(lines[1]).toContain("⚙ read_file (path: a.txt) ...");
      expect(lines[2]).toContain("✓ read_file — line1 line2");
      expect(lines[3]).toMatch(/^ {3}└─ explore#\d+ /);
      expect(lines[3]).toContain("步");
    } finally {
      spy.mockRestore();
    }
  });

  it("把子代理的最终报告完整渲染（中途正文不回显）", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const hook = new SubagentHook();
      hook.onTurnStart("研究 CLI 的输出链路");
      hook.onToolProposed("read_file", { path: "a.txt" });
      hook.onToolStarted("read_file");
      hook.onToolFinished("read_file", "ok", "line1 line2");
      hook.onAssistantMessage("我先看看 a.txt", []);
      hook.onAssistantMessage("# 探索报告\n\n- 结论：门禁在 security 模块", []);
      hook.onTurnEnd("completed", 2, []);
      const lines = spy.mock.calls.map((c) => String(c[0]));

      const titleIdx = lines.findIndex((l) => l.includes("报告"));
      expect(titleIdx).toBeGreaterThan(0);
      const block = lines.slice(titleIdx).join("\n");

      // 最后一条正文（即交给主代理的报告）被完整渲染，中途正文不重复回显
      expect(block).toContain("探索报告");
      expect(block).toContain("结论：门禁在 security 模块");
      expect(block).not.toContain("我先看看 a.txt");
      // 报告块整体缩进在子代理进度之下
      for (const line of block.split("\n")) {
        expect(line === "" || line.startsWith("   ")).toBe(true);
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe("ConsoleHook 的结果卡片", () => {
  /**
   * 捕获 stdout 写入（结果卡片走 cliWrite），并把终端列数固定为 80，
   * 让断言的宽度上限不随运行环境变化。
   */
  function captureWrite(): {
    chunks: string[];
    restore: () => void;
  } {
    const chunks: string[] = [];
    const before = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", {
      value: 80,
      configurable: true,
      writable: true,
    });
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
    return {
      chunks,
      restore: () => {
        spy.mockRestore();
        Object.defineProperty(process.stdout, "columns", {
          value: before,
          configurable: true,
          writable: true,
        });
      },
    };
  }

  it("compactResultTools 命中的工具，结果压成一行", () => {
    // preview 已把换行转义成字面量 \n，超宽的长文本默认会折行
    const preview = `{"report":"${"很长的一行".repeat(30)}"}`;
    const { chunks, restore } = captureWrite();
    try {
      const hook = new ConsoleHook({ compactResultTools: ["explore"] });
      hook.onToolProposed("explore", { task: "读 a.txt" });
      hook.onToolFinished("explore", "ok", preview);

      const resultLines = chunks
        .join("")
        .split("\n")
        .filter((l) => l.startsWith("结果: "));
      expect(resultLines).toHaveLength(1);
      expect(displayWidth(resultLines[0]!)).toBeLessThanOrEqual(80);
      expect(resultLines[0]!.endsWith("...")).toBe(true);
    } finally {
      restore();
    }
  });

  it("未命中的工具，结果保持原样展示", () => {
    const preview = '{"path":"a.txt","start_line":1,"end_line":2}';
    const { chunks, restore } = captureWrite();
    try {
      const hook = new ConsoleHook({ compactResultTools: ["explore"] });
      hook.onToolProposed("read_file", { path: "a.txt" });
      hook.onToolFinished("read_file", "ok", preview);

      expect(chunks.join("")).toContain(preview);
    } finally {
      restore();
    }
  });
});
