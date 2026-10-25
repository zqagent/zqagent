/** 线协议原语：varint、UTF-8、帧头边界。 */
import { describe, it, expect } from "vitest";
import {
  FrameType,
  MAX_FRAME_BYTES,
  decodeFrame,
  encodeFrame,
  frameTypeFromName,
  frameTypeName,
} from "../src/wire/frame.js";
import { fromHex, toHex } from "../src/wire/hex.js";
import { Reader, WireError, Writer } from "../src/wire/varint.js";
import { Utf8Error, utf8Decode, utf8Encode } from "../src/wire/utf8.js";

describe("varint", () => {
  it("写入后可读回（含 0/127/128/大数/bigint）", () => {
    for (const v of [0, 1, 127, 128, 300, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
      const w = new Writer();
      w.varint(v);
      const r = new Reader(w.finish());
      expect(r.varint()).toBe(BigInt(v));
    }
    const w = new Writer();
    w.varint(9007199254740993n);
    expect(new Reader(w.finish()).varint()).toBe(9007199254740993n);
  });

  it("Writer 扩容后内容完整", () => {
    const w = new Writer(8);
    for (let i = 0; i < 100; i++) w.u8(i);
    const out = w.finish();
    expect(out).toHaveLength(100);
    expect(out[99]).toBe(99);
  });

  it("拒绝负值、越界读取与超长 varint", () => {
    expect(() => new Writer().varint(-1)).toThrow(WireError);
    expect(() => new Reader(new Uint8Array([])).varint()).toThrow(WireError);
    expect(() => new Reader(new Uint8Array(10).fill(0x80)).varint()).toThrow(WireError);
    expect(() => new Reader(new Uint8Array([0x80])).u64()).toThrow(WireError);
  });

  it("u64 拒绝超出安全整数范围", () => {
    const w = new Writer();
    w.varint(2n ** 60n);
    expect(() => new Reader(w.finish()).u64()).toThrow(WireError);
  });

  it("tag 拒绝字段号 0", () => {
    const w = new Writer();
    w.varint(0);
    expect(() => new Reader(w.finish()).tag()).toThrow(WireError);
  });

  it("take 拒绝负长度/越界", () => {
    const r = new Reader(new Uint8Array([1, 2]));
    expect(() => r.take(-1)).toThrow(WireError);
    expect(() => r.take(3)).toThrow(WireError);
  });

  it("skip 支持四种 wire type 并拒绝未知值", () => {
    const w = new Writer();
    w.varint(5); // varint
    w.varint(2); w.raw(new Uint8Array([1, 2])); // len
    w.raw(new Uint8Array(8)); // fixed64
    w.raw(new Uint8Array(4)); // fixed32
    const r = new Reader(w.finish());
    r.skip(0);
    r.skip(2);
    r.skip(1);
    r.skip(5);
    expect(r.eof).toBe(true);
    expect(() => new Reader(new Uint8Array([0])).skip(3)).toThrow(WireError);
  });
});

describe("UTF-8", () => {
  it("往返 ASCII/中文/emoji", () => {
    for (const s of ["", "hello", "志前科技", "a😀b", "\u0000"]) {
      expect(utf8Decode(utf8Encode(s))).toBe(s);
    }
  });

  it("字节与标准实现一致", () => {
    expect([...utf8Encode("志")]).toEqual([...Buffer.from("志", "utf8")]);
    expect([...utf8Encode("😀")]).toEqual([...Buffer.from("😀", "utf8")]);
  });

  it("拒绝孤立代理项", () => {
    expect(() => utf8Encode("\ud800")).toThrow(Utf8Error);
    expect(() => utf8Encode("\udc00")).toThrow(Utf8Error);
    expect(() => utf8Encode("a\ud800b")).toThrow(Utf8Error);
  });

  it("拒绝非法起始/续接字节、截断、过长编码与代理项编码", () => {
    expect(() => utf8Decode(new Uint8Array([0xff]))).toThrow(Utf8Error);
    expect(() => utf8Decode(new Uint8Array([0xc2]))).toThrow(Utf8Error);
    expect(() => utf8Decode(new Uint8Array([0xc2, 0x41]))).toThrow(Utf8Error);
    expect(() => utf8Decode(new Uint8Array([0xc0, 0x80]))).toThrow(Utf8Error);
    expect(() => utf8Decode(new Uint8Array([0xed, 0xa0, 0x80]))).toThrow(Utf8Error);
    expect(() => utf8Decode(new Uint8Array([0xf4, 0x90, 0x80, 0x80]))).toThrow(Utf8Error);
  });
});

describe("hex", () => {
  it("往返并支持空串", () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
    expect([...fromHex("000fff")]).toEqual([0, 15, 255]);
    expect(fromHex("")).toHaveLength(0);
  });
});

describe("frame", () => {
  it("往返保留类型/序号/载荷", () => {
    const payload = new TextEncoder().encode("hello");
    const f = decodeFrame(encodeFrame({ type: FrameType.EVENT, seq: 42, payload }));
    expect(f.type).toBe(FrameType.EVENT);
    expect(f.seq).toBe(42);
    expect([...f.payload]).toEqual([...payload]);
  });

  it("拒绝非法帧类型/超限载荷", () => {
    expect(() => encodeFrame({ type: 16, seq: 0, payload: new Uint8Array() })).toThrow();
    expect(() => encodeFrame({ type: -1, seq: 0, payload: new Uint8Array() })).toThrow();
    const big = new Uint8Array(MAX_FRAME_BYTES + 1);
    expect(() => encodeFrame({ type: FrameType.EVENT, seq: 0, payload: big })).toThrow();
  });

  it("拒绝过短、magic 不符、版本不符、未知类型、len 不符", () => {
    expect(() => decodeFrame(new Uint8Array([0x5a, 0x51, 0x10]))).toThrow();
    expect(() => decodeFrame(new Uint8Array([0, 0, 0x10, 0, 0]))).toThrow();
    const versionBad = encodeFrame({ type: FrameType.EVENT, seq: 0, payload: new Uint8Array() });
    versionBad[2] = 0x20 | FrameType.EVENT;
    expect(() => decodeFrame(versionBad)).toThrow();
    const typeBad = encodeFrame({ type: FrameType.EVENT, seq: 0, payload: new Uint8Array() });
    typeBad[2] = 0x10 | 0x0f;
    expect(() => decodeFrame(typeBad)).toThrow();
    const lenBad = encodeFrame({ type: FrameType.EVENT, seq: 0, payload: new Uint8Array([1]) });
    expect(() => decodeFrame(lenBad.subarray(0, lenBad.length - 1))).toThrow();
  });

  it("帧类型名与值互转；未知名称/值抛错", () => {
    expect(frameTypeName(FrameType.EVENT)).toBe("EVENT");
    expect(frameTypeFromName("EVENT")).toBe(FrameType.EVENT);
    expect(() => frameTypeName(99)).toThrow();
    expect(() => frameTypeFromName("NOPE")).toThrow();
  });
});
