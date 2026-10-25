/**
 * 节点侧 wire 适配层（fleetWire.ts）：现有 fleet JSON 形状 ↔ protobuf 消息
 *
 * 这些是纯函数，因此能脱离连接把「形状映射」钉死——它是 MQTT 与 WSS 两条链路
 * 语义等价的**唯一保证点**。重点验证：
 *   - 往返一致（编码后再解码字段不丢）；
 *   - 富 JSON 与精简线上的取舍（Info 不带 label/usage，那是控制面数据）；
 *   - 时间戳 ISO ↔ 毫秒的映射；
 *   - 载荷保真（event/notify 的整段 JSON 原样进 data，终端消费端零改动）。
 */
import { describe, it, expect } from "vitest";
import {
  FrameType,
  decodeAck,
  decodeEvent,
  decodeFrame,
  decodeInfo,
  decodeNotify,
  decodeStatus,
  utf8Decode,
  utf8Encode,
  encodeEnvelope,
  type Envelope,
} from "@zqagent/shared/wire";
import {
  ACK_JSON_MAX_BYTES,
  encodeCmdFrame,
  encodeOutbound,
  fromWireCommand,
  guardAckSize,
  isoToMs,
  toWireAck,
  toWireEvent,
  toWireInfo,
  toWireNotify,
  toWireStatus,
} from "../src/server/fleet/fleetWire.js";
import type { FleetStatus } from "@zqagent/shared/fleet";

const NODE = "n-wire";

function frameOf(type: number, payload: Uint8Array): void {
  const f = decodeFrame(payload);
  expect(f.type).toBe(type);
  expect(f.seq).toBe(0);
}

describe("节点侧 wire 适配层", () => {
  it("ISO 时间字符串 → 毫秒；无法解析时归零", () => {
    const iso = "2026-03-04T05:06:07.008Z";
    expect(isoToMs(iso)).toBe(Date.parse(iso));
    expect(isoToMs(undefined)).toBe(0);
    expect(isoToMs("not-a-date")).toBe(0);
    expect(isoToMs(123 as unknown)).toBe(0);
  });

  it("status：ISO 时间字符串映射为毫秒，其余字段原样传递", () => {
    const s: FleetStatus = {
      nodeId: NODE,
      online: true,
      ts: "2026-03-04T05:06:07.008Z",
      label: "开发机",
      platform: "darwin",
      mode: "standalone",
      version: "1.2.3",
      ip: "10.0.0.9",
    };
    const wire = toWireStatus(s);
    expect(wire.ts).toBe(Date.parse(s.ts));
    expect(wire.online).toBe(true);
    expect(wire.label).toBe("开发机");
    expect(wire.ip).toBe("10.0.0.9");
  });

  it("info：计数字段仍走精简聚合，富字段（label/项目明细/stats/usage）走 detail 原样透传", () => {
    const blob = JSON.stringify({
      nodeId: NODE,
      label: "开发机",
      platform: "darwin",
      version: "1.2.3",
      ip: "10.0.0.9",
      projects: [{ id: "p1", name: "项目一" }],
      totals: { projects: 3, sessions: 7, running: 2, waiting: 1 },
      stats: { turns: 42 },
      usage: { total: { input: 1, output: 2 } },
      ts: "2026-03-04T05:06:07.008Z",
    });
    const info = toWireInfo(blob, NODE);
    // 计量字段：只取 totals 的四个计数（供网关快速聚合/查询）
    expect(info.projects).toBe(3);
    expect(info.sessions).toBe(7);
    expect(info.running).toBe(2);
    expect(info.waiting).toBe(1);
    expect(info.platform).toBe("darwin");
    expect(info.ip).toBe("10.0.0.9");
    expect(info.ts).toBe(Date.parse("2026-03-04T05:06:07.008Z"));

    // 富字段不再需要为控制面视图演进 schema：整段 JSON 原样进 detail。
    // 控制面 JSON.parse(detail) 得到的对象与从前读 retained info 完全一致。
    expect(info.detail).toBeDefined();
    const back = JSON.parse(utf8Decode(info.detail!)) as Record<string, unknown>;
    expect(back["label"]).toBe("开发机");
    expect(back["usage"]).toEqual({ total: { input: 1, output: 2 } });
    expect(back["stats"]).toEqual({ turns: 42 });
  });

  it("info：totals 缺失时计数按 0（而不是 undefined）上报，detail 仍原样带上", () => {
    const blob = JSON.stringify({ nodeId: NODE, label: "只有 label" });
    const info = toWireInfo(blob, NODE);
    expect([info.projects, info.sessions, info.running, info.waiting]).toEqual([0, 0, 0, 0]);
    const back = JSON.parse(utf8Decode(info.detail!)) as Record<string, unknown>;
    expect(back["label"]).toBe("只有 label");
  });

  it("info：非法 JSON 不抛错——计数归零但 detail 仍保留原文", () => {
    // 宁可让控制面看到原文（由它决定怎么处理），也不要在节点侧静默吞掉整条上报
    const info = toWireInfo("{ 不是 JSON", NODE);
    expect([info.projects, info.sessions, info.running, info.waiting]).toEqual([0, 0, 0, 0]);
    expect(utf8Decode(info.detail!)).toBe("{ 不是 JSON");
  });

  it("event：整段 JSON 原样进 data，游标留 0 由网关分配", () => {
    const json = JSON.stringify({
      type: "tool_finished",
      projectId: "p1",
      sessionId: "s1",
      data: { tool: "grep", ok: true },
    });
    const ev = toWireEvent(json)!;
    expect(ev.seq).toBe(0);
    expect(ev.type).toBe("tool_finished");
    expect(ev.projectId).toBe("p1");
    expect(ev.sessionId).toBe("s1");
    // 载荷保真：终端 JSON.parse(data) 与走 MQTT 收到的 payload 完全一致
    expect(JSON.parse(utf8Decode(ev.data!))).toEqual(JSON.parse(json));
  });

  it("event：批量合并串（{zqBatch:[...]}）同样原样透传", () => {
    const batch = `{"zqBatch":[{"type":"a"},{"type":"b"}]}`;
    const ev = toWireEvent(batch)!;
    // 批量串没有顶层 type —— 这是 MQTT 时代的容器形状，需要显式给出类型
    expect(ev.type).toBe("batch");
  });

  it("event/notify：非法 JSON 或缺关键字段时返回 null（调用方跳过并留痕）", () => {
    expect(toWireEvent("{ 不是 JSON")).toBeNull();
    expect(toWireEvent("[]")).toBeNull();
    expect(toWireEvent(JSON.stringify({ projectId: "p1" }))).toBeNull();
    expect(toWireNotify("{ 不是 JSON")).toBeNull();
    expect(toWireNotify(JSON.stringify({ projectId: "p1" }))).toBeNull();
  });

  it("notify：kind 与整段 JSON 都保留", () => {
    const json = JSON.stringify({
      kind: "approval_request",
      projectId: "p1",
      sessionId: "s1",
      data: { table: "|a|b|" },
    });
    const n = toWireNotify(json)!;
    expect(n.seq).toBe(0);
    expect(n.kind).toBe("approval_request");
    expect(JSON.parse(utf8Decode(n.data!)).data.table).toBe("|a|b|");
  });

  it("ack：data 走 JSON 字节；无 data 时不产生空负载", () => {
    const withData = toWireAck({ reqId: "r1", type: "ping", ok: true, data: { pong: 1 } });
    expect(withData.ok).toBe(true);
    expect(JSON.parse(utf8Decode(withData.data!))).toEqual({ pong: 1 });
    const noData = toWireAck({ reqId: "r2", type: "get_state", ok: false, error: "boom" });
    expect(noData.error).toBe("boom");
    expect(noData.data).toBeUndefined();
  });

  it("入站：wire 指令 → FleetCmdEnvelope（payload 由 JSON 字节解出）", () => {
    const env: Envelope = {
      t: 1_700_000_000_000,
      nonce: "abc",
      reqId: "r-9",
      type: "get_state",
      clientId: "web-1",
      nodeId: NODE,
      projectId: "p1",
      sessionId: "s1",
      payload: utf8Encode(JSON.stringify({ projectId: "p1", verbose: true })),
    };
    const got = fromWireCommand(env);
    expect(got.reqId).toBe("r-9");
    expect(got.type).toBe("get_state");
    expect(got.projectId).toBe("p1");
    expect(got.payload).toEqual({ projectId: "p1", verbose: true });
    // sig 置空：JSON 签名与 wire 签名不是同一个值，校验已在传输层完成
    expect(got.sig).toBe("");
  });

  it("入站：空载荷得到空对象（交由 FleetCommands 报参数缺失），不抛错", () => {
    const got = fromWireCommand({
      t: 1,
      nonce: "n",
      reqId: "r",
      type: "ping",
      clientId: "c",
      nodeId: NODE,
    });
    expect(got.payload).toEqual({});
  });

  it("入站：非 JSON 载荷不抛错，退化为空对象", () => {
    const got = fromWireCommand({
      t: 1,
      nonce: "n",
      reqId: "r",
      type: "ping",
      clientId: "c",
      nodeId: NODE,
      payload: new Uint8Array([0xff, 0xfe, 0xfd]),
    });
    expect(got.payload).toEqual({});
  });

  it("出站：五种上行的帧类型与往返字段都正确", () => {
    // status
    const statusFrame = encodeOutbound(
      { kind: "status", status: { nodeId: NODE, online: true, ts: new Date().toISOString() } },
      NODE,
    )!;
    frameOf(FrameType.STATUS, statusFrame);
    expect(decodeStatus(decodeFrame(statusFrame).payload).online).toBe(true);

    // info
    const infoFrame = encodeOutbound(
      { kind: "info", blob: JSON.stringify({ nodeId: NODE, totals: { sessions: 4 } }) },
      NODE,
    )!;
    frameOf(FrameType.INFO, infoFrame);
    expect(decodeInfo(decodeFrame(infoFrame).payload).sessions).toBe(4);

    // event
    const eventFrame = encodeOutbound(
      { kind: "event", json: JSON.stringify({ type: "turn_end", projectId: "p1" }) },
      NODE,
    )!;
    frameOf(FrameType.EVENT, eventFrame);
    const ev = decodeEvent(decodeFrame(eventFrame).payload);
    expect(ev.type).toBe("turn_end");
    expect(ev.projectId).toBe("p1");

    // notify
    const notifyFrame = encodeOutbound(
      { kind: "notify", json: JSON.stringify({ kind: "question", projectId: "p1" }) },
      NODE,
    )!;
    frameOf(FrameType.NOTIFY, notifyFrame);
    expect(decodeNotify(decodeFrame(notifyFrame).payload).kind).toBe("question");

    // ack
    const ackFrame = encodeOutbound(
      { kind: "ack", clientId: "web-1", ack: { reqId: "r1", type: "ping", ok: true } },
      NODE,
    )!;
    frameOf(FrameType.ACK, ackFrame);
    expect(decodeAck(decodeFrame(ackFrame).payload).reqId).toBe("r1");
  });

  it("出站：无法编码的消息返回 null（调用方跳过，不抛错打断上行）", () => {
    // event/notify 必须有可识别的结构（type/kind 或 zqBatch），否则无法编码
    expect(encodeOutbound({ kind: "event", json: "不是 JSON" }, NODE)).toBeNull();
    expect(encodeOutbound({ kind: "notify", json: "[]" }, NODE)).toBeNull();
  });

  it("出站：info 即使 JSON 非法也能编码（detail 原样保留，交由控制面判断）", () => {
    const frame = encodeOutbound({ kind: "info", blob: "不是 JSON" }, NODE);
    expect(frame).not.toBeNull();
    frameOf(FrameType.INFO, frame!);
    const info = decodeInfo(decodeFrame(frame!).payload);
    // 计数归零，但原文仍在 detail 里 —— 不静默丢弃整条上报
    expect(info.projects).toBe(0);
    expect(utf8Decode(info.detail!)).toBe("不是 JSON");
  });

  it("encodeCmdFrame 产出可解码的 CMD 帧（供测试与内联场景）", () => {
    const env: Envelope = {
      t: 1,
      nonce: "n",
      reqId: "r",
      type: "ping",
      clientId: "c",
      nodeId: NODE,
    };
    const frame = encodeCmdFrame(env);
    frameOf(FrameType.CMD, frame);
    expect(decodeFrame(frame).payload).toEqual(encodeEnvelope(env));
  });

  describe("guardAckSize：回执收进单帧", () => {
    /** 造一条指定 data 大小的回执（base64 是纯 ASCII，长度即可控） */
    const ackWith = (base64Len: number) => ({
      reqId: "r1",
      type: "zip_download",
      ok: true,
      data: { base64: "A".repeat(base64Len) },
    });

    it("小回执原样返回（不降级）", () => {
      const ack = ackWith(1024);
      expect(guardAckSize(ack, JSON.stringify(ack))).toBe(ack);
    });

    it("超过单帧上限时降级为错误回执，并说明实际大小", () => {
      const ack = ackWith(ACK_JSON_MAX_BYTES + 1024);
      const out = guardAckSize(ack, JSON.stringify(ack));
      expect(out.ok).toBe(false);
      expect(out.reqId).toBe("r1");
      expect(out.type).toBe("zip_download");
      expect(out.data).toBeUndefined();
      expect(out.error).toMatch(/结果过大/);
      expect(out.error).toMatch(/单帧传输上限/);
    });

    it("降级后的回执本身能编码成帧（不再触发超限）", () => {
      const ack = ackWith(ACK_JSON_MAX_BYTES * 2);
      const out = guardAckSize(ack, JSON.stringify(ack));
      const frame = encodeOutbound({ kind: "ack", clientId: "c1", ack: out }, NODE);
      expect(frame).not.toBeNull();
      expect(decodeFrame(frame!).type).toBe(FrameType.ACK);
      expect(decodeAck(decodeFrame(frame!).payload).ok).toBe(false);
    });

    it("失败回执不测量大小（本身很小，省一次扫描）", () => {
      const fail = { reqId: "r2", type: "zip_download", ok: false, error: "boom" };
      // 传入的不是真实序列化结果：若函数去量字节数会拿到 NaN 而误判
      expect(guardAckSize(fail, "")).toBe(fail);
    });

    it("边界：恰好等于上限时保留原回执", () => {
      // 用**与 ack 相同形状**的空壳算包装开销：type/reqId 长度会影响结果，
      // 拿一个字段不同的对象来算会差出十几字节
      const overhead = JSON.stringify(ackWith(0)).length;
      const ack = ackWith(ACK_JSON_MAX_BYTES - overhead);
      const json = JSON.stringify(ack);
      expect(Buffer.byteLength(json, "utf8")).toBe(ACK_JSON_MAX_BYTES);
      expect(guardAckSize(ack, json)).toBe(ack);
    });

    it("中文按 UTF-8 字节数判断（字符数不等于字节数）", () => {
      // 字符数只有上限的 1/3，但每个汉字 3 字节 → 实际超限
      const chars = Math.floor(ACK_JSON_MAX_BYTES / 3) + 1024;
      const ack = { reqId: "r4", type: "x", ok: true, data: { text: "中".repeat(chars) } };
      expect(JSON.stringify(ack).length).toBeLessThan(ACK_JSON_MAX_BYTES);
      expect(guardAckSize(ack, JSON.stringify(ack)).ok).toBe(false);
    });
  });
});
