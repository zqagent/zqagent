/**
 * UTF-8 编解码（手工实现，零依赖）
 *
 * 不依赖 TextEncoder/TextDecoder：小程序的 JS 运行时（部分基础库）不保证提供这两个全局，
 * 而本模块必须能被 Node / 浏览器 / 小程序三处共用。严格校验（拒绝孤立代理项、过长编码、
 * 超出码点范围）以对齐 protobuf 对 `string` 字段的 UTF-8 要求。
 */

export class Utf8Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Utf8Error";
  }
}

/** 字符串 → UTF-8 字节 */
export function utf8Encode(s: string): Uint8Array {
  const buf = new Uint8Array(s.length * 4); // 每字符最多 4 字节（上界）
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const lo = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (lo < 0xdc00 || lo > 0xdfff) throw new Utf8Error("孤立的 UTF-16 高代理项");
      cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
      i++;
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      throw new Utf8Error("孤立的 UTF-16 低代理项");
    }
    if (cp < 0x80) {
      buf[n++] = cp;
    } else if (cp < 0x800) {
      buf[n++] = 0xc0 | (cp >> 6);
      buf[n++] = 0x80 | (cp & 0x3f);
    } else if (cp < 0x10000) {
      buf[n++] = 0xe0 | (cp >> 12);
      buf[n++] = 0x80 | ((cp >> 6) & 0x3f);
      buf[n++] = 0x80 | (cp & 0x3f);
    } else {
      buf[n++] = 0xf0 | (cp >> 18);
      buf[n++] = 0x80 | ((cp >> 12) & 0x3f);
      buf[n++] = 0x80 | ((cp >> 6) & 0x3f);
      buf[n++] = 0x80 | (cp & 0x3f);
    }
  }
  return buf.slice(0, n);
}

/** UTF-8 字节 → 字符串（严格校验） */
export function utf8Decode(b: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < b.length) {
    const c = b[i]!;
    if (c < 0x80) {
      out += String.fromCharCode(c);
      i++;
      continue;
    }
    let cp: number;
    let need: number;
    let min: number;
    if ((c & 0xe0) === 0xc0) {
      cp = c & 0x1f;
      need = 1;
      min = 0x80;
    } else if ((c & 0xf0) === 0xe0) {
      cp = c & 0x0f;
      need = 2;
      min = 0x800;
    } else if ((c & 0xf8) === 0xf0) {
      cp = c & 0x07;
      need = 3;
      min = 0x10000;
    } else {
      throw new Utf8Error(`非法 UTF-8 起始字节 0x${c.toString(16)}`);
    }
    if (i + need >= b.length) throw new Utf8Error("UTF-8 序列被截断");
    for (let k = 1; k <= need; k++) {
      const cc = b[i + k]!;
      if ((cc & 0xc0) !== 0x80) throw new Utf8Error(`非法 UTF-8 续接字节 0x${cc.toString(16)}`);
      cp = (cp << 6) | (cc & 0x3f);
    }
    if (cp < min) throw new Utf8Error("UTF-8 过长编码（overlong）");
    if (cp > 0x10ffff) throw new Utf8Error("码点超出 U+10FFFF");
    if (cp >= 0xd800 && cp <= 0xdfff) throw new Utf8Error("UTF-8 编码了 UTF-16 代理项");
    i += need + 1;
    if (cp < 0x10000) {
      out += String.fromCharCode(cp);
    } else {
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    }
  }
  return out;
}
