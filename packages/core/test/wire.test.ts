/**
 * 线协议 v1 编解码测试（Node 侧）
 *
 * 覆盖：帧编解码与全部拒绝规则、信封/消息往返、签名一致性与篡改检测、
 * 未知字段前向兼容、以及**与提交入库的交叉向量逐字节一致**。
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FrameType,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  decodeAck,
  decodeAuth,
  decodeAuthOk,
  decodeEnvelope,
  decodeEvent,
  decodeFrame,
  decodeInfo,
  decodeNodeState,
  decodeNotify,
  decodeResume,
  decodeSnapshot,
  decodeStatus,
  decodeSubscribe,
  encodeAck,
  encodeAuth,
  encodeAuthOk,
  encodeEnvelope,
  encodeEvent,
  encodeFrame,
  encodeInfo,
  encodeNodeState,
  encodeNotify,
  encodeResume,
  encodeSnapshot,
  encodeStatus,
  encodeSubscribe,
  encodeTerminalData,
  decodeTerminalData,
  frameTypeFromName,
  frameTypeName,
  signableAuthBytes,
  signableBytes,
  toHex,
  fromHex,
  type Auth,
  type Envelope,
} from "@zqagent/shared/wire";
import { hmacSha256, signAuth, signEnvelope, verifyAuth, verifyEnvelope } from "@zqagent/shared/wire/node";

const here = path.dirname(fileURLToPath(import.meta.url));
const vectorsFile = path.resolve(here, "../../../proto/fixtures/wire-vectors.json");

interface FrameVector {
  name: string;
  typeName: string;
  seq: number;
  t: number;
  nonce: string;
  reqId: string;
  type: string;
  clientId: string;
  nodeId: string;
  projectId: string;
  sessionId: string;
  timeoutMs: number;
  payloadHex: string;
  signableHex: string;
  sigHex: string;
  envelopeHex: string;
  frameHex: string;
}

interface MessageVector {
  name: string;
  kind: "status" | "ack" | "event" | "terminal";
  json: Record<string, unknown>;
  hex: string;
}

/** 终端帧（`FrameType.TERMINAL`）：`frames` 是 CMD 专用结构，故单列一组 */
interface TerminalFrameVector {
  name: string;
  seq: number;
  nodeId: string;
  terminalId: string;
  kind: string;
  dataHex: string;
  payloadHex: string;
  frameHex: string;
}

const vectors = JSON.parse(fs.readFileSync(vectorsFile, "utf-8")) as {
  protocolVersion: number;
  secret: string;
  frames: FrameVector[];
  messages: MessageVector[];
  terminalFrames: TerminalFrameVector[];
};

describe("线协议：帧编解码", () => {
  it("所有已定义帧类型可往返", () => {
    for (const [name, type] of Object.entries(FrameType)) {
      const payload = new Uint8Array([1, 2, 3]);
      const encoded = encodeFrame({ type, seq: 42, payload });
      const decoded = decodeFrame(encoded);
      expect(decoded.type, name).toBe(type);
      expect(decoded.seq).toBe(42);
      expect(toHex(decoded.payload)).toBe("010203");
    }
  });

  it("空载荷与最大序号可往返", () => {
    const encoded = encodeFrame({ type: FrameType.PING, seq: 0, payload: new Uint8Array(0) });
    const decoded = decodeFrame(encoded);
    expect(decoded.seq).toBe(0);
    expect(decoded.payload.length).toBe(0);
  });

  it("帧头字节序符合规范（magic=ZQ，ver 在高 4 位）", () => {
    const encoded = encodeFrame({ type: FrameType.CMD, seq: 1, payload: new Uint8Array(0) });
    expect(encoded[0]).toBe(0x5a);
    expect(encoded[1]).toBe(0x51);
    expect(encoded[2]).toBe((PROTOCOL_VERSION << 4) | FrameType.CMD);
  });

  it("拒绝非法输入", () => {
    const ok = encodeFrame({ type: FrameType.CMD, seq: 1, payload: new Uint8Array(0) });

    // 过短
    expect(() => decodeFrame(ok.slice(0, 3))).toThrow(/帧过短/);

    // magic 不符
    const badMagic = ok.slice();
    badMagic[0] = 0x00;
    expect(() => decodeFrame(badMagic)).toThrow(/magic/);

    // 版本不支持
    const badVer = ok.slice();
    badVer[2] = (9 << 4) | FrameType.CMD;
    expect(() => decodeFrame(badVer)).toThrow(/协议版本/);

    // 低 4 位的 16 个取值（0..=15）已全部占用（TERMINAL 是最后一个），
    // 已无「未定义帧类型」可作负例：后续演进只能升协议版本（上一分支覆盖）。
    expect(FrameType.TERMINAL).toBe(15);

    // len 与剩余字节不符
    const extra = new Uint8Array(ok.length + 1);
    extra.set(ok);
    expect(() => decodeFrame(extra)).toThrow(/不符/);

    // len 超上限（伪造一个大 len，不实际分配）
    expect(() =>
      decodeFrame(new Uint8Array([0x5a, 0x51, (PROTOCOL_VERSION << 4) | 7, 1, 0xff, 0xff, 0xff, 0x7f])),
    ).toThrow(/超限/);
  });

  it("编码时拒绝超限载荷", () => {
    expect(() =>
      encodeFrame({ type: FrameType.EVENT, seq: 1, payload: new Uint8Array(MAX_FRAME_BYTES + 1) }),
    ).toThrow(/超限/);
  });

  it("帧类型名与值互转一致", () => {
    expect(frameTypeFromName("ACK")).toBe(FrameType.ACK);
    expect(frameTypeName(FrameType.ACK)).toBe("ACK");
    expect(() => frameTypeFromName("NOPE")).toThrow();
  });
});

describe("线协议：信封与签名", () => {
  const baseEnvelope: Envelope = {
    t: 1_700_000_000_000,
    nonce: "n1",
    reqId: "r1",
    type: "ping",
    clientId: "gw-1",
    nodeId: "node-1",
  };

  it("往返保持字段", () => {
    const env: Envelope = {
      ...baseEnvelope,
      projectId: "p1",
      sessionId: "s1",
      payload: Uint8Array.from([0, 255, 16]),
    };
    const decoded = decodeEnvelope(encodeEnvelope(env));
    expect(decoded.t).toBe(env.t);
    expect(decoded.nonce).toBe("n1");
    expect(decoded.reqId).toBe("r1");
    expect(decoded.type).toBe("ping");
    expect(decoded.clientId).toBe("gw-1");
    expect(decoded.nodeId).toBe("node-1");
    expect(decoded.projectId).toBe("p1");
    expect(decoded.sessionId).toBe("s1");
    expect(toHex(decoded.payload!)).toBe("00ff10");
    expect(decoded.sig).toBeUndefined();
  });

  it("proto3 默认值不写线（空串字段被省略）", () => {
    const empty = encodeEnvelope({
      t: 0,
      nonce: "",
      reqId: "",
      type: "",
      clientId: "",
      nodeId: "",
    });
    expect(empty.length).toBe(0);
  });

  it("sig 置空后的编码等于签名字节（校验方重编码成立）", () => {
    const signed = signEnvelope("secret", baseEnvelope);
    const bytesWithSig = encodeEnvelope(signed);
    const bytesWithout = encodeEnvelope({ ...signed, sig: undefined });
    expect(toHex(bytesWithout)).toBe(toHex(signableBytes(baseEnvelope)));
    // sig 是 10 号字段（最后），因此去掉 sig 的编码是带签名编码的前缀
    expect(toHex(bytesWithSig.slice(0, bytesWithout.length))).toBe(toHex(bytesWithout));
  });

  it("签名可验证，且篡改任一字段即失败", () => {
    const signed = signEnvelope("secret", baseEnvelope);
    expect(verifyEnvelope("secret", signed)).toBe(true);
    expect(verifyEnvelope("wrong-secret", signed)).toBe(false);
    expect(verifyEnvelope("secret", { ...signed, nodeId: "node-2" })).toBe(false);
    expect(verifyEnvelope("secret", { ...signed, payload: Uint8Array.from([1]) })).toBe(false);
    expect(verifyEnvelope("secret", { ...signed, sig: undefined })).toBe(false);
    expect(verifyEnvelope("secret", { ...signed, sig: new Uint8Array(31) })).toBe(false);
  });

  it("HMAC 为 32 字节裸输出", () => {
    expect(hmacSha256("secret", Uint8Array.from([1, 2, 3])).length).toBe(32);
  });

  it("未知字段被跳过（前向兼容）", () => {
    const bytes = encodeEnvelope(baseEnvelope);
    // 追加未知字段：字段号 99、wire type 0（varint）、值 5
    const extra = new Uint8Array(bytes.length + 3);
    extra.set(bytes);
    extra.set([0x98, 0x06, 0x05], bytes.length);
    const decoded = decodeEnvelope(extra);
    expect(decoded.nodeId).toBe("node-1");
  });

  it("非法 XML 越过 UTF-8 边界判错", () => {
    // 伪造：字段 2（nonce）长度 2，内容为非法 UTF-8 续接字节
    expect(() => decodeEnvelope(Uint8Array.from([0x12, 0x02, 0x80, 0x80]))).toThrow();
  });
});

describe("线协议：上行/回执消息", () => {
  it("Status 往返", () => {
    const st = {
      nodeId: "node-1",
      online: true,
      ts: 1_700_000_000_000,
      platform: "linux",
      version: "0.1.59",
    };
    expect(decodeStatus(encodeStatus(st))).toEqual(st);
  });

  it("Ack 往返", () => {
    const ack = { reqId: "r1", type: "ping", ok: false, error: "boom" };
    expect(decodeAck(encodeAck(ack))).toEqual(ack);
  });

  it("Event 往返", () => {
    const ev = { seq: 7, ts: 1_700_000_000_000, type: "turn_end", data: Uint8Array.from([9]) };
    const decoded = decodeEvent(encodeEvent(ev));
    expect(decoded.seq).toBe(7);
    expect(decoded.ts).toBe(ev.ts);
    expect(decoded.type).toBe("turn_end");
    expect(toHex(decoded.data!)).toBe("09");
  });
});

describe("线协议：握手与订阅（M2）", () => {
  const secret = "wire-test-secret";
  const baseAuth: Auth = {
    id: "node-a",
    ts: 1_700_000_000_000,
    nonce: "n1",
    proto: 1,
    kind: "node",
  };

  it("Auth 往返；无 scope/expires 时 token 是最后一个字段（前缀即签名字节）", () => {
    const signed = signAuth(secret, baseAuth);
    const bytesWithToken = encodeAuth(signed);
    const bytesWithout = encodeAuth({ ...signed, token: undefined });
    expect(toHex(bytesWithout)).toBe(toHex(signableAuthBytes(baseAuth)));
    expect(toHex(bytesWithToken.slice(0, bytesWithout.length))).toBe(toHex(bytesWithout));
    const decoded = decodeAuth(bytesWithToken);
    expect(decoded.id).toBe("node-a");
    expect(decoded.proto).toBe(1);
    expect(verifyAuth(secret, decoded)).toBe(true);
  });

  it("Auth 带 scope/expires 可往返，且二者参与签名（M5 终端令牌）", () => {
    const terminal: Auth = {
      ...baseAuth,
      id: "user-1",
      kind: "terminal",
      client: "web",
      scope: ["node-a", "node-b"],
      expires: 1_700_003_600_000,
    };
    const signed = signAuth(secret, terminal);
    const decoded = decodeAuth(encodeAuth(signed));
    expect(decoded.scope).toEqual(["node-a", "node-b"]);
    expect(decoded.expires).toBe(1_700_003_600_000);
    expect(verifyAuth(secret, decoded)).toBe(true);

    // scope/expires 字段号在 token **之后**，但按字段号升序编码 ⇒ 仍在签名字节内。
    // 篡改任一者都必须让签名失效，否则「授权范围」可被客户端自行放宽。
    expect(verifyAuth(secret, { ...signed, scope: ["node-a", "node-b", "node-c"] })).toBe(false);
    expect(verifyAuth(secret, { ...signed, scope: [] })).toBe(false);
    expect(verifyAuth(secret, { ...signed, expires: signed.expires! + 86_400_000 })).toBe(false);

    // 与无 scope 的对照：此刻 token 后面确有字段，故「前缀 = 签名字节」不再成立
    const signable = signableAuthBytes(terminal);
    expect(toHex(signable)).not.toBe(
      toHex(encodeAuth(signed).slice(0, signable.length)),
      "有 token 之后字段时，签名字节不是带签名编码的前缀",
    );
  });

  it("签名可验证；篡改 id/kind/client 任一字段即失败（kind 参与签名）", () => {
    const signed = signAuth(secret, baseAuth);
    expect(verifyAuth(secret, signed)).toBe(true);
    expect(verifyAuth("other", signed)).toBe(false);
    expect(verifyAuth(secret, { ...signed, id: "node-b" })).toBe(false);
    expect(verifyAuth(secret, { ...signed, kind: "terminal" })).toBe(false);
    expect(verifyAuth(secret, { ...signed, client: "web" })).toBe(false);
    expect(verifyAuth(secret, { ...signed, token: new Uint8Array(31) })).toBe(false);
  });

  it("AuthOk 往返（含失败原因）", () => {
    expect(decodeAuthOk(encodeAuthOk({ ok: true, serverTs: 5 }))).toEqual({ ok: true, serverTs: 5 });
    expect(decodeAuthOk(encodeAuthOk({ ok: false, error: "签名校验失败", serverTs: 7 }))).toEqual({
      ok: false,
      error: "签名校验失败",
      serverTs: 7,
    });
  });

  it("Snapshot 往返（含多节点与 seq 游标）", () => {
    const snap = {
      nodes: [
        { nodeId: "node-a", online: true, lastSeen: 100, platform: "linux", version: "0.1.0" },
        { nodeId: "node-b", online: false, lastSeen: 200 },
      ],
      seq: 42,
    };
    expect(decodeSnapshot(encodeSnapshot(snap))).toEqual(snap);
    expect(decodeNodeState(encodeNodeState(snap.nodes[0]!))).toEqual(snap.nodes[0]);
  });

  it("Subscribe / Unsubscribe / Resume 往返", () => {
    const ids = ["n1", "n2", "n3"];
    expect(decodeSubscribe(encodeSubscribe(ids))).toEqual(ids);
    expect(decodeSubscribe(encodeSubscribe([]))).toEqual([]);
    expect(decodeResume(encodeResume(1234))).toEqual({ since: 1234 });
    expect(decodeResume(encodeResume(0))).toEqual({ since: 0 });
  });

  it("Notify 往返（审批请求等需可靠送达的上行）", () => {
    const data = new TextEncoder().encode('{"approvalId":"a1","toolName":"run_shell"}');
    const n = {
      seq: 0,
      ts: 1_700_000_000_000,
      kind: "approval_request",
      projectId: "p1",
      sessionId: "s1",
      data,
    };
    expect(decodeNotify(encodeNotify(n))).toEqual(n);
    // 最小字段
    const min = { seq: 7, ts: 1, kind: "turn_completed" };
    expect(decodeNotify(encodeNotify(min))).toEqual(min);
    // 与 Event 不共用 frame type
    expect(FrameType.NOTIFY).toBe(6);
    expect(frameTypeName(FrameType.NOTIFY)).toBe("NOTIFY");
  });

  it("AUTH_OK 是独立帧类型（不与 AUTH 复用）", () => {    expect(FrameType.AUTH_OK).toBe(14);
    expect(frameTypeName(FrameType.AUTH_OK)).toBe("AUTH_OK");
    expect(frameTypeFromName("AUTH_OK")).toBe(FrameType.AUTH_OK);
    const frame = encodeFrame({ type: FrameType.AUTH_OK, seq: 0, payload: new Uint8Array(0) });
    expect(decodeFrame(frame).type).toBe(FrameType.AUTH_OK);
  });
});

describe("线协议：握手向量（提交入库的字节基准）", () => {
  interface HandshakeVector {
    name: string;
    id: string;
    ts: number;
    nonce: string;
    proto: number;
    kind: string;
    client: string;
    scope?: string[];
    expires?: number;
    signableHex: string;
    tokenHex: string;
    authHex: string;
  }
  const hs = (vectors as unknown as { handshakes: HandshakeVector[] }).handshakes;

  it("向量齐备", () => {
    expect(hs.length).toBeGreaterThanOrEqual(3);
    expect(hs.some((h) => h.kind === "node")).toBe(true);
    expect(hs.some((h) => h.kind === "terminal")).toBe(true);
  });

  it("signable / token / auth 全部逐字节一致", () => {
    for (const h of hs) {
      const input: Auth = {
        id: h.id,
        ts: h.ts,
        nonce: h.nonce,
        proto: h.proto,
        kind: h.kind,
        client: h.client || undefined,
        scope: h.scope,
        expires: h.expires,
      };
      expect(toHex(signableAuthBytes(input)), `${h.name} signable`).toBe(h.signableHex);
      expect(toHex(hmacSha256(vectors.secret, signableAuthBytes(input))), `${h.name} token`).toBe(h.tokenHex);
      const signed = signAuth(vectors.secret, input);
      expect(toHex(encodeAuth(signed)), `${h.name} auth`).toBe(h.authHex);
      // 解码 + 校验
      const decoded = decodeAuth(fromHex(h.authHex));
      expect(decoded.id).toBe(h.id);
      expect(verifyAuth(vectors.secret, decoded)).toBe(true);
    }
  });
});

describe("线协议：可移植性（浏览器/小程序约束）", () => {
  const wireDir = path.resolve(here, "../../shared/src/wire");
  // 可移植模块：Node / 浏览器 / 小程序三处共用，不得触碰任何 Node / 平台 API
  const portable = ["index.ts", "varint.ts", "frame.ts", "messages.ts", "utf8.ts", "hex.ts"];
  const forbidden: Array<[RegExp, string]> = [
    [/from\s+["']node:/, "import node: 内置模块"],
    [/require\s*\(/, "使用 require()"],
    [/\bBuffer\b/, "使用 Buffer（小程序无）"],
    [/\bprocess\./, "使用 process"],
    [/from\s+["'](crypto|buffer|net|tls|fs)["']/, "import Node 内置模块"],
  ];

  it("可移植模块不引用 Node / 平台 API", () => {
    for (const file of portable) {
      const src = fs.readFileSync(path.join(wireDir, file), "utf-8");
      // 先剥离注释：注释里提及 Node API 是合理的，只有实际引用才算违规
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const [re, why] of forbidden) {
        expect(re.test(code), `${file} 不应${why}`).toBe(false);
      }
    }
  });

  it("签名按平台拆分：node.ts 使用 node:crypto", () => {
    const src = fs.readFileSync(path.join(wireDir, "node.ts"), "utf-8");
    expect(src).toMatch(/from\s+["']node:crypto["']/);
  });
});

describe("线协议：交叉向量（提交入库的字节基准）", () => {
  it("向量版本与当前协议一致", () => {
    expect(vectors.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it("信封：签名字节、签名、信封、帧全部逐字节一致", () => {
    for (const v of vectors.frames) {
      const input: Envelope = {
        t: v.t,
        nonce: v.nonce,
        reqId: v.reqId,
        type: v.type,
        clientId: v.clientId,
        nodeId: v.nodeId,
        projectId: v.projectId,
        sessionId: v.sessionId,
        payload: fromHex(v.payloadHex),
        timeoutMs: v.timeoutMs,
      };

      expect(toHex(signableBytes(input)), `${v.name} signable`).toBe(v.signableHex);
      expect(toHex(hmacSha256(vectors.secret, signableBytes(input))), `${v.name} sig`).toBe(v.sigHex);

      const signed = signEnvelope(vectors.secret, input);
      expect(toHex(encodeEnvelope(signed)), `${v.name} envelope`).toBe(v.envelopeHex);

      const frame = encodeFrame({
        type: frameTypeFromName(v.typeName),
        seq: v.seq,
        payload: encodeEnvelope(signed),
      });
      expect(toHex(frame), `${v.name} frame`).toBe(v.frameHex);

      // 解码方向：帧 → 信封 → 字段与签名校验
      const decodedFrame = decodeFrame(fromHex(v.frameHex));
      expect(decodedFrame.type).toBe(frameTypeFromName(v.typeName));
      expect(decodedFrame.seq).toBe(v.seq);
      const decodedEnv = decodeEnvelope(decodedFrame.payload);
      expect(decodedEnv.nodeId).toBe(v.nodeId);
      expect(decodedEnv.type).toBe(v.type);
      expect(toHex(decodedEnv.sig!)).toBe(v.sigHex);
      expect(verifyEnvelope(vectors.secret, decodedEnv)).toBe(true);
    }
  });

  it("终端帧：帧头与载荷逐字节一致（与 Rust 网关同基准）", () => {
    for (const t of vectors.terminalFrames) {
      const td = {
        nodeId: t.nodeId || undefined,
        terminalId: t.terminalId,
        kind: t.kind,
        data: t.dataHex ? fromHex(t.dataHex) : undefined,
        seq: t.seq,
      };
      const payload = encodeTerminalData(td);
      expect(toHex(payload), `${t.name} 载荷`).toBe(t.payloadHex);
      expect(toHex(encodeFrame({ type: FrameType.TERMINAL, seq: t.seq, payload }))).toBe(
        t.frameHex,
      );

      const frame = decodeFrame(fromHex(t.frameHex));
      expect(frame.type, `${t.name} 帧类型`).toBe(FrameType.TERMINAL);
      expect(frame.seq).toBe(t.seq);
      const back = decodeTerminalData(frame.payload);
      expect(back.terminalId).toBe(t.terminalId);
      expect(back.kind).toBe(t.kind);
      expect(back.nodeId ?? "").toBe(t.nodeId);
    }
  });

  it("消息：编码逐字节一致且可往返", () => {
    for (const m of vectors.messages) {
      const json = m.json;
      let encoded: Uint8Array;
      let decoded: unknown;
      if (m.kind === "status") {
        const st = {
          nodeId: String(json["nodeId"]),
          online: Boolean(json["online"]),
          ts: Number(json["ts"]),
          label: (json["label"] as string) || undefined,
          platform: (json["platform"] as string) || undefined,
          mode: (json["mode"] as string) || undefined,
          version: (json["version"] as string) || undefined,
          ip: (json["ip"] as string) || undefined,
        };
        encoded = encodeStatus(st);
        decoded = decodeStatus(fromHex(m.hex));
      } else if (m.kind === "ack") {
        const dataHex = String(json["dataHex"] ?? "");
        const ack = {
          reqId: String(json["reqId"]),
          type: String(json["type"]),
          ok: Boolean(json["ok"]),
          error: (json["error"] as string) || undefined,
          data: dataHex ? fromHex(dataHex) : undefined,
        };
        encoded = encodeAck(ack);
        decoded = decodeAck(fromHex(m.hex));
      } else if (m.kind === "subscribe") {
        const ids = (json["ids"] as string[]) ?? [];
        encoded = encodeSubscribe(ids);
        decoded = decodeSubscribe(fromHex(m.hex));
        // 订阅向量只比对节点集合与字节，跳过后面的 toMatchObject（结构不同）
        expect(toHex(encoded), `${m.kind}/${m.name} 编码`).toBe(m.hex);
        expect(decoded, `${m.kind}/${m.name} 解码`).toEqual(ids);
        continue;
      } else if (m.kind === "snapshot") {
        const snap = {
          nodes: ((json["nodes"] as Array<Record<string, unknown>>) ?? []).map((n) => ({
            nodeId: String(n["nodeId"]),
            online: Boolean(n["online"]),
            lastSeen: Number(n["lastSeen"]),
            platform: (n["platform"] as string) || undefined,
            version: (n["version"] as string) || undefined,
            ip: (n["ip"] as string) || undefined,
            detail: n["detailHex"] ? fromHex(String(n["detailHex"])) : undefined,
          })),
          seq: Number(json["seq"] ?? 0),
        };
        encoded = encodeSnapshot(snap);
        expect(toHex(encoded), `${m.kind}/${m.name} 编码`).toBe(m.hex);
        const back = decodeSnapshot(fromHex(m.hex));
        expect(back.seq, `${m.kind}/${m.name} seq`).toBe(snap.seq);
        expect(back.nodes.length, `${m.kind}/${m.name} 节点数`).toBe(snap.nodes.length);
        for (let i = 0; i < back.nodes.length; i++) {
          expect(back.nodes[i], `${m.kind}/${m.name} 节点 ${i}`).toEqual(snap.nodes[i]);
        }
        continue;
      } else if (m.kind === "notify") {
        const dataHex = String(json["dataHex"] ?? "");
        const n = {
          seq: Number(json["seq"] ?? 0),
          ts: Number(json["ts"]),
          kind: String(json["kind"]),
          projectId: (json["projectId"] as string) || undefined,
          sessionId: (json["sessionId"] as string) || undefined,
          data: dataHex ? fromHex(dataHex) : undefined,
          nodeId: (json["nodeId"] as string) || undefined,
        };
        encoded = encodeNotify(n);
        decoded = decodeNotify(fromHex(m.hex));
      } else if (m.kind === "info") {
        const info = {
          nodeId: String(json["nodeId"]),
          platform: (json["platform"] as string) || undefined,
          version: (json["version"] as string) || undefined,
          ip: (json["ip"] as string) || undefined,
          projects: Number(json["projects"] ?? 0),
          sessions: Number(json["sessions"] ?? 0),
          running: Number(json["running"] ?? 0),
          waiting: Number(json["waiting"] ?? 0),
          ts: Number(json["ts"] ?? 0),
        };
        encoded = encodeInfo(info);
        expect(toHex(encoded), `${m.kind}/${m.name} 编码`).toBe(m.hex);
        const back = decodeInfo(fromHex(m.hex));
        expect(back, `${m.kind}/${m.name} 解码`).toEqual(info);
        continue;
      } else if (m.kind === "terminal") {
        const dataHex = String(json["dataHex"] ?? "");
        const td = {
          nodeId: (json["nodeId"] as string) || undefined,
          terminalId: String(json["terminalId"]),
          kind: String(json["kind"]),
          data: dataHex ? fromHex(dataHex) : undefined,
          seq: Number(json["seq"] ?? 0),
        };
        encoded = encodeTerminalData(td);
        expect(toHex(encoded), `${m.kind}/${m.name} 编码`).toBe(m.hex);
        // 逐字段比对：seq=0 属 proto3 默认值，不写线，解码得到 undefined
        const back = decodeTerminalData(fromHex(m.hex));
        expect(back.terminalId, `${m.kind}/${m.name} terminalId`).toBe(td.terminalId);
        expect(back.kind, `${m.kind}/${m.name} kind`).toBe(td.kind);
        expect(back.nodeId ?? "", `${m.kind}/${m.name} nodeId`).toBe(td.nodeId ?? "");
        expect(toHex(back.data ?? new Uint8Array(0)), `${m.kind}/${m.name} data`).toBe(
          toHex(td.data ?? new Uint8Array(0)),
        );
        expect(back.seq ?? 0, `${m.kind}/${m.name} seq`).toBe(td.seq);
        continue;
      } else {
        const dataHex = String(json["dataHex"] ?? "");
        const ev = {
          seq: Number(json["seq"]),
          ts: Number(json["ts"]),
          type: String(json["type"]),
          projectId: (json["projectId"] as string) || undefined,
          sessionId: (json["sessionId"] as string) || undefined,
          data: dataHex ? fromHex(dataHex) : undefined,
          nodeId: (json["nodeId"] as string) || undefined,
        };
        encoded = encodeEvent(ev);
        decoded = decodeEvent(fromHex(m.hex));
      }
      expect(toHex(encoded), `${m.kind}/${m.name} 编码`).toBe(m.hex);
      expect(decoded, `${m.kind}/${m.name} 解码`).toMatchObject(
        Object.fromEntries(
          Object.entries(json).filter(([k]) => k !== "dataHex"),
        ),
      );
    }
  });
});
