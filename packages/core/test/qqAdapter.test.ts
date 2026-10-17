/**
 * QqAdapter 命令闭环单测
 *
 * 用 fake QqClient + mock SessionManager + 真实 Store/Bindings/PairingCodes，
 * 验证绑定、任务提交、审批、提问、状态等命令路由与回复。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Store } from "../src/server/store.js";
import type { SessionManager } from "../src/server/session.js";
import type { SessionRecord } from "../src/server/types.js";
import { QqAdapter, notifyToQqText } from "../src/server/qq/QqAdapter.js";
import { QqBindingsStore } from "../src/server/qq/bindings.js";
import { PairingCodeStore } from "../src/server/qq/pairingCodes.js";
import type { QqClient, QqMessage, QqTarget } from "../src/server/qq/types.js";

interface Sent {
  target: QqTarget;
  content: string;
  msgId?: string;
}

function makeClient() {
  const sent: Sent[] = [];
  let handler: ((msg: QqMessage) => void | Promise<void>) | null = null;
  const client: QqClient = {
    start: async () => {},
    stop: () => {},
    send: async (target, content, msgId) => {
      sent.push({ target, content, msgId });
    },
    onMessage: (h) => {
      handler = h;
    },
    onStatus: () => {},
  };
  return {
    client,
    sent,
    emit: (msg: QqMessage) => handler!(msg),
  };
}

const target: QqTarget = { kind: "c2c", openid: "user-1" };

function msg(content: string): QqMessage {
  return { eventId: "e1", content, target, msgId: "m1", senderId: "user-1" };
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "sess-1",
    tenantId: "demo",
    model: "m",
    modelOverridden: false,
    messages: [],
    compaction: null,
    status: "idle",
    approvals: [],
    questions: [],
    sessionAllowTools: [],
    sessionAllowCommands: [],
    savedAt: "",
    ...overrides,
  };
}

describe("QqAdapter", () => {
  let dir: string;
  let store: Store;
  let bindings: QqBindingsStore;
  let pairingCodes: PairingCodeStore;
  let manager: SessionManager;
  let cc: ReturnType<typeof makeClient>;
  let adapter: QqAdapter;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-adapter-"));
    store = new Store(dir);
    store.saveTenant({ id: "demo", apiKey: "demo-key", model: "m", provider: {} });
    bindings = QqBindingsStore.in(dir);
    pairingCodes = new PairingCodeStore();

    manager = {
      createSession: vi.fn(() => makeRecord()),
      listSessions: vi.fn(() => []),
      getSession: vi.fn(() => makeRecord()),
      submitTurn: vi.fn(),
      submitOrSteer: vi.fn(() => "started" as const),
      answerApproval: vi.fn(),
      answerQuestion: vi.fn(),
      interrupt: vi.fn(),
    } as unknown as SessionManager;

    cc = makeClient();
    adapter = new QqAdapter({ client: cc.client, store, manager, bindings, pairingCodes });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("单租户未绑定直接发任务 → 自动绑定并提交", async () => {
    await adapter.handleMessage(msg("写点东西"));
    expect(manager.submitOrSteer).toHaveBeenCalledWith(
      expect.anything(),
      "sess-1",
      "写点东西",
    );
    expect(cc.sent.at(-1)!.content).toContain("任务已提交");
  });

  it("单租户直接 /bind（无码）绑定成功", async () => {
    await adapter.handleMessage(msg("/bind"));
    expect(cc.sent.at(-1)!.content).toContain("绑定成功");
    expect(cc.sent.at(-1)!.content).toContain("demo");

    // 绑定后可直接发任务
    await adapter.handleMessage(msg("写点东西"));
    expect(manager.submitOrSteer).toHaveBeenCalledWith(
      expect.anything(),
      "sess-1",
      "写点东西",
    );
  });

  it("配对码绑定后发任务 → 提交", async () => {
    const { code } = pairingCodes.issue("demo");
    await adapter.handleMessage(msg(`/bind ${code}`));
    expect(cc.sent.at(-1)!.content).toContain("绑定成功");

    await adapter.handleMessage(msg("写点东西"));
    expect(manager.submitOrSteer).toHaveBeenCalledWith(
      expect.anything(),
      "sess-1",
      "写点东西",
    );
    expect(cc.sent.at(-1)!.content).toContain("任务已提交");
  });

  it("配对码单次消费", async () => {
    const { code } = pairingCodes.issue("demo");
    await adapter.handleMessage(msg(`/bind ${code}`));
    // 同一个码第二次绑定到另一个会话
    const target2: QqTarget = { kind: "c2c", openid: "user-2" };
    await adapter.handleMessage({
      eventId: "e2",
      content: `/bind ${code}`,
      target: target2,
      msgId: "m2",
      senderId: "user-2",
    });
    expect(cc.sent.at(-1)!.content).toContain("无效或已过期");
  });

  it("approve 无待审批 → 提示", async () => {
    bindings.set("u:user-1", { tenantId: "demo", sessionId: "sess-1" });
    await adapter.handleMessage(msg("/approve once"));
    expect(manager.answerApproval).not.toHaveBeenCalled();
    expect(cc.sent.at(-1)!.content).toContain("没有待审批");
  });

  it("存在待审批 → answerApproval", async () => {
    bindings.set("u:user-1", { tenantId: "demo", sessionId: "sess-1" });
    (manager.getSession as ReturnType<typeof vi.fn>).mockReturnValue(
      makeRecord({
        approvals: [
          {
            id: "a1",
            toolName: "write_file",
            arguments: {},
            reason: "需要写文件",
            status: "pending",
            createdAt: "",
          },
        ],
      }),
    );
    await adapter.handleMessage(msg("/approve deny"));
    expect(manager.answerApproval).toHaveBeenCalledWith(
      expect.anything(),
      "sess-1",
      "a1",
      "deny",
    );
  });

  it("待审批时回复「同意」→ 作为审批结果（once）", async () => {
    bindings.set("u:user-1", { tenantId: "demo", sessionId: "sess-1" });
    (manager.getSession as ReturnType<typeof vi.fn>).mockReturnValue(
      makeRecord({
        approvals: [
          {
            id: "a1",
            toolName: "write_file",
            arguments: {},
            reason: "需要写文件",
            status: "pending",
            createdAt: "",
          },
        ],
      }),
    );
    await adapter.handleMessage(msg("同意"));
    expect(manager.answerApproval).toHaveBeenCalledWith(
      expect.anything(),
      "sess-1",
      "a1",
      "once",
    );
    expect(cc.sent.at(-1)!.content).toContain("已提交审批结果");
  });

  it("待审批时回复无关文本 → 提示等待审批，不提交新任务", async () => {
    bindings.set("u:user-1", { tenantId: "demo", sessionId: "sess-1" });
    (manager.getSession as ReturnType<typeof vi.fn>).mockReturnValue(
      makeRecord({
        approvals: [
          {
            id: "a1",
            toolName: "write_file",
            arguments: {},
            reason: "需要写文件",
            status: "pending",
            createdAt: "",
          },
        ],
      }),
    );
    await adapter.handleMessage(msg("帮我做点别的事"));
    expect(manager.submitOrSteer).not.toHaveBeenCalled();
    expect(cc.sent.at(-1)!.content).toContain("等待审批");
  });

  it("运行中发消息 → 作为补充信息(steer)", async () => {
    bindings.set("u:user-1", { tenantId: "demo", sessionId: "sess-1" });
    (manager.getSession as ReturnType<typeof vi.fn>).mockReturnValue(
      makeRecord({ status: "running" }),
    );
    (manager.submitOrSteer as ReturnType<typeof vi.fn>).mockReturnValue("steered");
    await adapter.handleMessage(msg("再补充一点：记得加单测"));
    expect(manager.submitOrSteer).toHaveBeenCalledWith(
      expect.anything(),
      "sess-1",
      "再补充一点：记得加单测",
    );
    expect(cc.sent.at(-1)!.content).toContain("补充信息");
  });

  it("new 新建会话", async () => {
    const { code } = pairingCodes.issue("demo");
    await adapter.handleMessage(msg(`/bind ${code}`));
    (manager.createSession as ReturnType<typeof vi.fn>).mockReturnValue(
      makeRecord({ sessionId: "sess-new" }),
    );
    await adapter.handleMessage(msg("/new"));
    expect(manager.createSession).toHaveBeenCalled();
    expect(cc.sent.at(-1)!.content).toContain("sess-new");
  });

  it("stop 中断", async () => {
    bindings.set("u:user-1", { tenantId: "demo", sessionId: "sess-1" });
    await adapter.handleMessage(msg("/stop"));
    expect(manager.interrupt).toHaveBeenCalledWith(expect.anything(), "sess-1");
  });

  it("onNotify 审批通知完整发送到 QQ（含工具名与参数）", async () => {
    bindings.set("u:user-1", { tenantId: "demo", sessionId: "sess-1" });
    await adapter.onNotify("demo", {
      kind: "approval_request",
      sessionId: "sess-1",
      ts: "",
      data: {
        toolName: "write_file",
        arguments: { path: "/tmp/a.txt", content: "hello" },
        reason: "需要写文件",
      },
    });
    const content = cc.sent.at(-1)!.content;
    expect(content).toContain("write_file");
    expect(content).toContain("/tmp/a.txt");
    expect(content).toContain("hello");
    expect(content).toContain("全部同意");
  });
});

describe("notifyToQqText", () => {
  it("完成通知附摘要", () => {
    const text = notifyToQqText({
      kind: "turn_completed",
      sessionId: "s",
      ts: "",
      data: { status: "completed", summary: "完成了" },
    });
    expect(text).toContain("完成了");
  });

  it("审批通知含工具参数与全部同意选项", () => {
    const text = notifyToQqText({
      kind: "approval_request",
      sessionId: "s",
      ts: "",
      data: {
        toolName: "write_file",
        reason: "写文件",
        arguments: { path: "/tmp/a.txt", content: "hello" },
      },
    });
    expect(text).toContain("write_file");
    expect(text).toContain("| 项目 | 详情 |");
    expect(text).toContain("/tmp/a.txt");
    expect(text).toContain("全部同意");
    expect(text).toContain("同意(仅本次)");
  });

  it("审批参数超长时截断", () => {
    const text = notifyToQqText({
      kind: "approval_request",
      sessionId: "s",
      ts: "",
      data: {
        toolName: "write_file",
        reason: "写文件",
        arguments: { content: "x".repeat(2000) },
      },
    });
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(900);
  });
});
