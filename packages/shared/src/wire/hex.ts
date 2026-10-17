/** 十六进制编解码（可移植，向量文件与调试用） */

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const s = hex.trim();
  if (s.length % 2 !== 0) throw new Error(`十六进制长度必须为偶数: ${s.length}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`非法十六进制内容: ${s.slice(i * 2, i * 2 + 2)}`);
    out[i] = byte;
  }
  return out;
}
