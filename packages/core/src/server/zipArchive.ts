/**
 * 最小 ZIP 打包器（零依赖）
 *
 * 为什么自己写：Node 标准库只有 gzip/deflate 这类**单文件**压缩流，没有归档格式；
 * 引入 archiver / jszip 会新增一条运行时依赖，而这里只需要「把若干文件按目录结构
 * 打成一个 .zip」这一种能力。ZIP 的 store/deflate 两种模式用 zlib 就能覆盖。
 *
 * 只实现必需的部分：UTF-8 文件名（通用标志位 bit 11）、deflate 或 store、
 * 目录项（尾部带 `/`，让解压工具能还原空目录）。不支持 zip64——
 * 100MB 级归档远在 4GB 偏移上限之内，超出由调用方的大小上限拦住。
 */
import * as zlib from "zlib";

/** ZIP 单个归档的条目上限（防止误选一个超大目录把内存打满） */
export const MAX_ZIP_ENTRIES = 20000;

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** 通用标志位：bit 11 = 文件名是 UTF-8 */
const FLAG_UTF8 = 0x0800;
/** 压缩方法 */
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

export interface ZipEntryInput {
  /** 归档内路径（POSIX 分隔符，无前导斜杠）；目录必须以 `/` 结尾 */
  name: string;
  /** 文件内容；目录不传 */
  data?: Buffer;
  /** 修改时间（写入 DOS 时间戳；缺省用当前时间） */
  mtime?: Date;
}

/** CRC32 查表（ZIP 要求的 IEEE 802.3 多项式） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

/** JS Date → DOS 时间/日期（ZIP 用 1980 起算的本地时间，秒粒度 2s） */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

interface CentralRecord {
  name: Buffer;
  method: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
  time: number;
  date: number;
  isDir: boolean;
}

/**
 * 打成一个 zip 归档。
 *
 * 对每个条目先 deflate，**压缩后反而更大时退回 store**（图片/压缩包这类内容
 * deflate 基本无效，存原始字节既省 CPU 也不会让归档变大）。
 */
export function buildZip(entries: ZipEntryInput[]): Buffer {
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`归档条目过多（${entries.length} > ${MAX_ZIP_ENTRIES}）`);
  }

  const chunks: Buffer[] = [];
  const central: CentralRecord[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf-8");
    const isDir = e.name.endsWith("/");
    const raw = isDir ? Buffer.alloc(0) : (e.data ?? Buffer.alloc(0));
    let method = METHOD_STORE;
    let body = raw;

    if (!isDir && raw.length > 0) {
      const deflated = zlib.deflateRawSync(raw, { level: 6 });
      if (deflated.length < raw.length) {
        method = METHOD_DEFLATE;
        body = deflated;
      }
    }

    const crc = isDir ? 0 : crc32(raw);
    const { time, date } = dosDateTime(e.mtime ?? new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    chunks.push(local, name);
    if (body.length > 0) chunks.push(body);

    central.push({
      name,
      method,
      crc,
      csize: body.length,
      usize: raw.length,
      offset,
      time,
      date,
      isDir,
    });
    offset += local.length + name.length + body.length;
  }

  const cdStart = offset;
  for (const c of central) {
    const head = Buffer.alloc(46);
    head.writeUInt32LE(CENTRAL_SIG, 0);
    head.writeUInt16LE(20, 4); // version made by
    head.writeUInt16LE(20, 6); // version needed
    head.writeUInt16LE(FLAG_UTF8, 8);
    head.writeUInt16LE(c.method, 10);
    head.writeUInt16LE(c.time, 12);
    head.writeUInt16LE(c.date, 14);
    head.writeUInt32LE(c.crc, 16);
    head.writeUInt32LE(c.csize, 20);
    head.writeUInt32LE(c.usize, 24);
    head.writeUInt16LE(c.name.length, 28);
    head.writeUInt16LE(0, 30); // extra
    head.writeUInt16LE(0, 32); // comment
    head.writeUInt16LE(0, 34); // disk start
    head.writeUInt16LE(0, 36); // internal attrs
    // 外部属性：目录置目录位（0x41ED 的低位 = MS-DOS 目录属性 0x10）
    head.writeUInt32LE(c.isDir ? 0x10 : 0, 38);
    head.writeUInt32LE(c.offset, 42);
    chunks.push(head, c.name);
    offset += head.length + c.name.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(offset - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  chunks.push(eocd);

  return Buffer.concat(chunks);
}
