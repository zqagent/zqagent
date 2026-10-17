/**
 * 最小 protobuf 原语（varint + length-delimited 读写，零依赖）
 *
 * Node 与浏览器/小程序共用：只用 `Uint8Array`（`Buffer` 是其子类）与 `DataView`，
 * 不触碰任何平台 API。编码规则严格对齐 proto3 线格式（默认值省略、字段号升序），
 * 以便与 Rust 侧 `prost` 产出**逐字节一致**的结果（见 docs/wire-protocol.md §5）。
 */
import { utf8Encode, utf8Decode } from "./utf8.js";

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LEN = 2;
export const WIRE_FIXED32 = 5;

export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireError";
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const EMPTY = new Uint8Array(0);

/** 增量字节写入器（自动扩容） */
export class Writer {
  private buf: Uint8Array;
  private len = 0;

  constructor(initialCapacity = 64) {
    this.buf = new Uint8Array(Math.max(8, initialCapacity));
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  /** 裸字节（帧头用，不带任何前缀） */
  u8(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b & 0xff;
  }

  raw(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  /** 无符号 varint（接受 number 或 bigint） */
  varint(v: number | bigint): void {
    let x = typeof v === "bigint" ? v : BigInt(v);
    if (x < 0n) throw new WireError("varint 不接受负值");
    this.ensure(10);
    while (x >= 0x80n) {
      this.buf[this.len++] = Number((x & 0x7fn) | 0x80n);
      x >>= 7n;
    }
    this.buf[this.len++] = Number(x);
  }

  tag(field: number, wire: number): void {
    this.varint((field << 3) | wire);
  }

  /** length-delimited：长度 varint + 内容 */
  lenPrefixed(b: Uint8Array): void {
    this.varint(b.length);
    this.raw(b);
  }

  // ---- proto3 字段：默认值不写线 ----

  uint64Field(field: number, v: number | bigint): void {
    const x = typeof v === "bigint" ? v : BigInt(v);
    if (x === 0n) return;
    this.tag(field, WIRE_VARINT);
    this.varint(x);
  }

  boolField(field: number, v: boolean): void {
    if (!v) return;
    this.tag(field, WIRE_VARINT);
    this.varint(1);
  }

  stringField(field: number, v: string): void {
    if (v === "") return;
    this.tag(field, WIRE_LEN);
    this.lenPrefixed(utf8Encode(v));
  }

  bytesField(field: number, v: Uint8Array): void {
    if (v.length === 0) return;
    this.tag(field, WIRE_LEN);
    this.lenPrefixed(v);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }

  get length(): number {
    return this.len;
  }
}

/** 顺序字节读取器（越界一律判错） */
export class Reader {
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  varint(): bigint {
    let shift = 0n;
    let result = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.buf.length) throw new WireError("varint 越界");
      const b = this.buf[this.pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        if (i === 9 && b > 1) throw new WireError("varint 溢出（超过 64 位）");
        return result;
      }
      shift += 7n;
    }
    throw new WireError("varint 超过 10 字节");
  }

  /** u64 → number（超安全整数范围即判错，避免静默精度丢失） */
  u64(): number {
    const v = this.varint();
    if (v > MAX_SAFE) throw new WireError(`u64 超出 JS 安全整数范围: ${v}`);
    return Number(v);
  }

  tag(): { field: number; wire: number } {
    const t = this.varint();
    const field = Number(t >> 3n);
    const wire = Number(t & 7n);
    if (field <= 0) throw new WireError("字段号必须 ≥ 1");
    return { field, wire };
  }

  /** 取 n 个字节（越界判错） */
  take(n: number): Uint8Array {
    if (!Number.isInteger(n) || n < 0) throw new WireError(`非法长度: ${n}`);
    if (this.pos + n > this.buf.length) {
      throw new WireError(`读取越界：需要 ${n} 字节，剩余 ${this.buf.length - this.pos}`);
    }
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** length-delimited：读长度再取其内容 */
  lenPrefixed(): Uint8Array {
    return this.take(this.u64());
  }

  string(): string {
    return utf8Decode(this.lenPrefixed());
  }

  /** 跳过未知字段（前向兼容的关键：未来新增字段号不应导致解析失败） */
  skip(wire: number): void {
    switch (wire) {
      case WIRE_VARINT:
        this.varint();
        return;
      case WIRE_LEN:
        this.lenPrefixed();
        return;
      case WIRE_FIXED64:
        this.take(8);
        return;
      case WIRE_FIXED32:
        this.take(4);
        return;
      default:
        throw new WireError(`不支持的 wire type: ${wire}`);
    }
  }
}

export { EMPTY as EMPTY_BYTES };
