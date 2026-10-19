/**
 * InputRouter 行输入路由单测
 *
 * 用 readline + PassThrough 模拟 stdin 行输入,验证:
 *   1. ask 等待一行并 resolve;
 *   2. 运行中(有 steering 目标)行输入 → queueSteering;
 *   3. 空行不触发 steering;
 *   4. 有等待者时行输入优先作为回答;
 *   5. 无消费者时暂存、下次 ask 消费;
 *   6. suspend/resume;
 *   7. 并发 ask 逐个受理(不丢等待者)。
 * 另测提示符重绘(退格不丢提示符)、Tab 键模式切换与 countRawEscapes
 * (裸 ESC 检测的 CSI 过滤)。
 */
import { describe, it, expect, vi } from "vitest";
import * as readline from "readline";
import { PassThrough } from "stream";
import { InputRouter, countRawEscapes, patchReadlineHistoryNav } from "../src/cli/input.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await sleep(5);
  }
}

function makeRouter() {
  const input = new PassThrough();
  input.resume();
  const rl = readline.createInterface({
    input,
    output: new PassThrough(),
    terminal: false,
  });
  const prompts: string[] = [];
  const steered: string[] = [];
  const router = new InputRouter({
    rl,
    stdout: {
      write: (s: string) => {
        prompts.push(s);
        return true;
      },
    },
    onSteered: (t) => steered.push(t),
  });
  return { input, rl, router, prompts, steered };
}

/**
 * TTY 模式 router:terminal:true 时 readline 走 _ttyWrite 路径,
 * 可验证 bracketed paste 拦截逻辑(粘贴多行不提交)。
 */
function makeRouterTTY() {
  const input = new PassThrough();
  input.resume();
  const output = new PassThrough();
  (output as unknown as { columns: number }).columns = 80;
  const outChunks: string[] = [];
  output.on("data", (c: Buffer) => outChunks.push(c.toString("utf8")));
  const rl = readline.createInterface({
    input,
    output,
    terminal: true,
  });
  const prompts: string[] = [];
  const steered: string[] = [];
  const router = new InputRouter({
    rl,
    stdout: {
      write: (s: string) => {
        prompts.push(s);
        return true;
      },
    },
    onSteered: (t) => steered.push(t),
  });
  return {
    input,
    rl,
    router,
    prompts,
    steered,
    outText: () => outChunks.join(""),
  };
}

describe("InputRouter 行输入路由", () => {
  it("ask 等待一行输入并 resolve", async () => {
    const { router, input, prompts } = makeRouter();
    const p = router.ask("> ");
    input.write("hello\n");
    await expect(p).resolves.toBe("hello");
    expect(prompts).toEqual(["> "]);
  });

  it("运行中(有 steering 目标)行输入 → queueSteering", async () => {
    const { router, input, steered } = makeRouter();
    const queueSteering = vi.fn();
    router.setSteeringTarget({ queueSteering });
    input.write("请补充细节\n");
    await waitFor(() => queueSteering.mock.calls.length === 1);
    expect(queueSteering).toHaveBeenCalledWith("请补充细节");
    expect(steered).toEqual(["请补充细节"]);
  });

  it("运行中空行不触发 steering", async () => {
    const { router, input } = makeRouter();
    const queueSteering = vi.fn();
    router.setSteeringTarget({ queueSteering });
    input.write("   \n");
    await sleep(30);
    expect(queueSteering).not.toHaveBeenCalled();
  });

  it("有等待者时行输入优先作为回答,不 steering", async () => {
    const { router, input } = makeRouter();
    const queueSteering = vi.fn();
    router.setSteeringTarget({ queueSteering });
    const p = router.ask("? ");
    input.write("answer\n");
    await expect(p).resolves.toBe("answer");
    expect(queueSteering).not.toHaveBeenCalled();
  });

  it("并发 ask 逐个受理:先回答第一个,再显示第二个提示符", async () => {
    const { router, input, prompts } = makeRouter();
    // 引擎并发执行交互类工具(如 ask_user + request_directory)时会出现两个 ask 同时挂起
    const first = router.ask("  [Y] 批准  [D] 拒绝: ");
    const second = router.ask("  请选择 序号或文字: ");
    await sleep(20);
    // 第二个提示符必须等第一个被回答后才出现,否则两行输入无法区分归属
    expect(prompts).toEqual(["  [Y] 批准  [D] 拒绝: "]);

    input.write("y\n");
    await expect(first).resolves.toBe("y");
    expect(prompts).toEqual(["  [Y] 批准  [D] 拒绝: ", "  请选择 序号或文字: "]);

    input.write("3\n");
    await expect(second).resolves.toBe("3");
  });

  it("无消费者时输入暂存,下次 ask 消费", async () => {
    const { router, input } = makeRouter();
    input.write("early\n");
    await sleep(20);
    const p = router.ask("> ");
    await expect(p).resolves.toBe("early");
  });

  it("suspend 期间忽略行,resume 恢复", async () => {
    const { router, input } = makeRouter();
    router.suspend();
    const p = router.ask("> ");
    input.write("ignored\n");
    await sleep(20);
    router.resume();
    input.write("real\n");
    await expect(p).resolves.toBe("real");
  });
});

describe("InputRouter 多行粘贴 (bracketed paste)", () => {
  it("粘贴多行不提交,Enter 后才还原为完整多行文本", async () => {
    const { router, input, rl } = makeRouterTTY();
    const p = router.ask("> ");

    // 模拟终端 bracketed paste:标记 + 多行(换行为 \r) + 结束标记
    input.write("\x1b[200~第一行\r第二行\x1b[201~");
    await sleep(30);

    // 粘贴期间/结束后不应触发提交
    let resolved = false;
    p.then(() => (resolved = true));
    await sleep(20);
    expect(resolved).toBe(false);
    // 输入行中应出现占位符(不含真实换行)
    expect(rl.line).toContain("[粘贴文本 #1");
    expect(rl.line).not.toContain("\n");

    // 手按 Enter 才提交,并还原为完整多行文本
    input.write("\r");
    await expect(p).resolves.toBe("第一行\n第二行");
  });

  it("粘贴文本前后可继续追加,提交时一并还原", async () => {
    const { router, input } = makeRouterTTY();
    const p = router.ask("> ");

    input.write("前缀 ");
    input.write("\x1b[200~A\rB\x1b[201~");
    input.write(" 后缀");
    await sleep(30);

    input.write("\r");
    await expect(p).resolves.toBe("前缀 A\nB 后缀");
  });

  it("运行中粘贴多行 → Enter 后 steering 收到完整文本", async () => {
    const { router, input, steered } = makeRouterTTY();
    const queueSteering = vi.fn();
    router.setSteeringTarget({ queueSteering });

    input.write("\x1b[200~补充一行\r补充二行\x1b[201~");
    await sleep(30);
    // 未按 Enter 前不应 steering
    expect(queueSteering).not.toHaveBeenCalled();

    input.write("\r");
    await waitFor(() => queueSteering.mock.calls.length === 1);
    expect(queueSteering).toHaveBeenCalledWith("补充一行\n补充二行");
    expect(steered).toEqual(["补充一行\n补充二行"]);
  });

  it("粘贴单行完整显示在输入框,不使用占位符", async () => {
    const { router, input, rl } = makeRouterTTY();
    const p = router.ask("> ");

    input.write("\x1b[200~只有一行\x1b[201~");
    await sleep(30);

    // 单行粘贴直接插入原文,不折叠为占位符
    expect(rl.line).toBe("只有一行");
    expect(rl.line).not.toContain("粘贴文本");

    input.write("\r");
    await expect(p).resolves.toBe("只有一行");
  });

  it("空粘贴不插入占位符", async () => {
    const { router, input, rl } = makeRouterTTY();
    const p = router.ask("> ");

    input.write("\x1b[200~\x1b[201~");
    await sleep(30);
    expect(rl.line).toBe("");

    input.write("\r");
    await expect(p).resolves.toBe("");
  });
});

describe("InputRouter 提示符重绘", () => {
  it("退格重绘时重写完整提示符(不再退化成默认的 \"> \")", async () => {
    const { router, input, outText } = makeRouterTTY();
    const p = router.ask("[interactive][code] > ");

    input.write("hi");
    input.write("\x7f"); // backspace
    await sleep(20);
    input.write("\r");
    await expect(p).resolves.toBe("h");

    // readline 重绘会先清屏(\x1b[0J)再重写「提示符 + 当前行」,
    // 最后一次清屏之后必须出现完整提示符,而不是默认 "> "。
    const redraws = outText().split("\x1b[0J");
    expect(redraws).toHaveLength(2);
    expect(redraws[1]).toContain("[interactive][code] > h");
  });

  it("含换行的提示符只把最后一行交给 readline(重绘不重复换行)", async () => {
    const { router, input, rl, outText } = makeRouterTTY();
    const p = router.ask("\n[plan][code] > ");

    expect((rl as unknown as { _prompt: string })._prompt).toBe("[plan][code] > ");

    input.write("x");
    input.write("\x7f");
    await sleep(20);
    input.write("\r");
    await expect(p).resolves.toBe("");

    // 重绘(清屏之后的片段)恰好以最后一行提示符开头,不带前导换行
    expect(outText().split("\x1b[0J")[1]).toMatch(/^\[plan\]\[code\] > /);
  });
});

describe("InputRouter Tab 键切换模式", () => {
  it("拦截 Tab:触发回调,既不插入制表符也不提交当前行", async () => {
    const { router, input, rl } = makeRouterTTY();
    const handler = vi.fn();
    router.setTabHandler(handler);
    const p = router.ask("> ");

    input.write("ab");
    input.write("\t");
    await sleep(20);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(rl.line).toBe("ab"); // 未插入制表符

    let resolved = false;
    p.then(() => (resolved = true));
    await sleep(20);
    expect(resolved).toBe(false); // Tab 不提交当前行

    input.write("\r");
    await expect(p).resolves.toBe("ab");
  });

  it("传 null 清除回调后 Tab 恢复原生行为(不再触发)", async () => {
    const { router, input } = makeRouterTTY();
    const handler = vi.fn();
    router.setTabHandler(handler);
    router.setTabHandler(null);
    const p = router.ask("> ");

    input.write("\t");
    await sleep(20);
    expect(handler).not.toHaveBeenCalled();

    input.write("\r");
    // 原生 Tab 在无补全器时直接插入制表符（我们不再拦截）
    await expect(p).resolves.toBe("\t");
  });

  it("粘贴态中的 Tab 不触发模式切换", async () => {
    const { router, input } = makeRouterTTY();
    const handler = vi.fn();
    router.setTabHandler(handler);
    const p = router.ask("> ");

    input.write("\x1b[200~a\tb\x1b[201~");
    await sleep(30);
    expect(handler).not.toHaveBeenCalled();

    input.write("\r");
    await expect(p).resolves.toBe("a\tb"); // 制表符作为粘贴内容保留
  });

  it("refreshPrompt 原地改写提示符并保留已输入内容", async () => {
    const { router, input, rl, outText } = makeRouterTTY();
    const p = router.ask("\n[interactive][code] > ");
    expect(router.currentPrompt()).toBe("[interactive][code] > ");

    input.write("hi");
    await sleep(20);
    router.refreshPrompt("\n[plan][code] > ");
    await sleep(20);

    expect(router.currentPrompt()).toBe("[plan][code] > ");
    expect(outText()).toContain("[plan][code] > hi");

    input.write("\r");
    await expect(p).resolves.toBe("hi");
    expect((rl as unknown as { _prompt: string })._prompt).toBe("[plan][code] > ");
  });
});

describe("patchReadlineHistoryNav 历史导航", () => {
  it("上下切换历史后恢复正在输入的内容与光标位置", async () => {
    const { rl, input } = makeRouterTTY();
    patchReadlineHistoryNav(rl);
    rl.history = ["最近一条", "更早一条"];
    rl.historyIndex = -1;

    input.write("draft text");
    await sleep(20);
    expect(rl.line).toBe("draft text");

    input.write("\x1b[A"); // up → 最近一条
    await sleep(20);
    expect(rl.line).toBe("最近一条");

    input.write("\x1b[A"); // up → 更早一条
    await sleep(20);
    expect(rl.line).toBe("更早一条");

    input.write("\x1b[B"); // down → 最近一条
    await sleep(20);
    expect(rl.line).toBe("最近一条");

    input.write("\x1b[B"); // down → 回到草稿
    await sleep(20);
    expect(rl.line).toBe("draft text");
    expect(rl.cursor).toBe("draft text".length);
  });

  it("提交历史行后草稿失效,不会在下次导航时复活", async () => {
    const { rl, input } = makeRouterTTY();
    patchReadlineHistoryNav(rl);
    rl.history = ["历史行"];
    rl.historyIndex = -1;

    input.write("old draft");
    await sleep(20);
    input.write("\x1b[A"); // 进入历史
    await sleep(20);
    expect(rl.line).toBe("历史行");

    input.write("\r"); // 提交历史行 → 草稿应失效
    await sleep(20);

    input.write("new draft");
    await sleep(20);
    input.write("\x1b[A"); // 进入历史
    await sleep(20);
    input.write("\x1b[B"); // 回到草稿
    await sleep(20);
    expect(rl.line).toBe("new draft");
  });
});

describe("countRawEscapes", () => {
  it("统计裸 ESC", () => {
    expect(countRawEscapes("\x1b")).toBe(1);
    expect(countRawEscapes("\x1b\x1b")).toBe(2);
  });

  it("剔除 CSI 序列(方向键/Alt 组合)", () => {
    expect(countRawEscapes("\x1b[A")).toBe(0);
    expect(countRawEscapes("\x1b[1;5C")).toBe(0);
    expect(countRawEscapes("\x1bOA")).toBe(0);
  });

  it("普通文本无 ESC", () => {
    expect(countRawEscapes("hello world")).toBe(0);
  });

  it("Buffer 输入同样处理", () => {
    expect(countRawEscapes(Buffer.from("\x1b"))).toBe(1);
    expect(countRawEscapes(Buffer.from("abc\x1b"))).toBe(1);
  });
});
