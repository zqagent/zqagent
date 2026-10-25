/**
 * 用户消息附件（图片 / 音频 / 视频）
 *
 * 语义：**随本轮请求发送，并把原文件存进会话目录**。
 *   - 前端读文件后转成 base64 data URL 交给节点；
 *   - 节点把它内联进供应商请求（Chat: `image_url`，Responses: `input_image`）；
 *   - 同时把字节写进 `sessions/<id>/attachments/`，消息里只留轻量引用
 *     `StoredAttachment`（文件名 / 类型 / 字节数 / 路径），避免 base64 把
 *     session.json 撑爆；控制台据此显示缩略图，聊天详情里也能回看。
 *
 * 大小上限按「**所有传输通道都能承载**」取 10MB：
 *   原始文件 10MB → base64 约 13.4MB；节点 HTTP body 上限 24MB，
 *   网关/共享 wire 的单帧上限 16MB，均留有包装开销余量。
 */
import * as fs from "fs";
import * as path from "path";
import {
  CAPABILITY_LABELS_ZH,
  capabilityOfMime,
  type AttachmentCapability,
} from "@zqagent/shared/model-capabilities";


/** 一次提交的附件总大小上限（原文件字节数，不含 base64 膨胀） */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** 一次提交的附件个数上限（DeepSeek 单请求最多 600 张，这里只是防误操作） */
export const MAX_ATTACHMENTS = 4;

/** 单个附件 */
export interface MessageAttachment {
  /** 原始文件名（展示 + 供应商侧提示用） */
  name: string;
  /** MIME 类型（如 image/png），与 dataUrl 内声明的一致 */
  mimeType: string;
  /** `data:<mime>;base64,<payload>` */
  dataUrl: string;
}

/** 附件校验失败（调用方转成 400，避免把供应商的晦涩报错暴露给用户） */
export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

/** data URL 的 MIME 声明（`data:image/png;base64,xxx` → `image/png`） */
const DATA_URL_RE = /^data:([\w.+-]+\/[\w.+-]+);base64,/i;

/** 附件的实际字节数（按 base64 长度反推，不真正解码） */
export function attachmentBytes(a: MessageAttachment): number {
  const comma = a.dataUrl.indexOf(",");
  if (comma < 0) return 0;
  const b64 = a.dataUrl.slice(comma + 1).replace(/=+$/, "");
  return Math.floor((b64.length * 3) / 4);
}

/** 能力对应的中文名（错误提示用） */
function capLabel(cap: AttachmentCapability): string {
  return CAPABILITY_LABELS_ZH[cap];
}

/**
 * 校验并规范化请求里的附件。
 *
 * 返回 `undefined` 表示「没有附件」。任何不合法（类型不支持、超限、data URL 格式错）
 * 都抛 `AttachmentError`，由 HTTP / 指令层转成 400——静默丢弃会让用户以为图发出去了。
 */
export function normalizeAttachments(v: unknown): MessageAttachment[] | undefined {
  if (v == null) return undefined;
  if (!Array.isArray(v)) throw new AttachmentError("attachments 必须是数组");
  if (v.length === 0) return undefined;
  if (v.length > MAX_ATTACHMENTS) {
    throw new AttachmentError(`附件最多 ${MAX_ATTACHMENTS} 个`);
  }

  const out: MessageAttachment[] = [];
  let total = 0;
  for (const [i, raw] of v.entries()) {
    if (!raw || typeof raw !== "object") {
      throw new AttachmentError(`第 ${i + 1} 个附件格式不正确`);
    }
    const rec = raw as Record<string, unknown>;
    const dataUrl = String(rec.dataUrl ?? "").trim();
    const m = DATA_URL_RE.exec(dataUrl);
    if (!m) {
      throw new AttachmentError(`第 ${i + 1} 个附件缺少 base64 data URL`);
    }
    const mimeType = String(rec.mimeType ?? m[1] ?? "").trim().toLowerCase() || m[1]!;
    if (mimeType !== m[1]!.toLowerCase()) {
      throw new AttachmentError(`第 ${i + 1} 个附件的类型与内容不一致`);
    }
    const cap = capabilityOfMime(mimeType);
    if (!cap) {
      throw new AttachmentError(`第 ${i + 1} 个附件不是受支持的${capLabel("image")}/${capLabel("audio")}/${capLabel("video")}`);
    }
    const name = String(rec.name ?? "").trim().slice(0, 200) || `${capLabel(cap)}附件`;
    const item: MessageAttachment = { name, mimeType, dataUrl };
    const bytes = attachmentBytes(item);
    if (bytes > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(
        `${name} 超过单个附件 ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB 上限`,
      );
    }
    total += bytes;
    if (total > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(
        `附件合计超过 ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB 上限`,
      );
    }
    out.push(item);
  }
  return out;
}

/**
 * 已落盘的附件引用（消息 / 事件 / 轮次索引里只带它，不带 base64）。
 *
 * `path` 相对会话目录（如 `attachments/1712-0-shot.png`），前端按
 * `readSessionAttachment` 取回内容。
 */
export interface StoredAttachment {
  /** 原始文件名（展示用） */
  name: string;
  /** MIME 类型 */
  mimeType: string;
  /** 原始字节数 */
  size: number;
  /** 相对会话目录的路径（POSIX 分隔符） */
  path: string;
}

/** 附件目录名（相对会话目录） */
export const ATTACHMENT_DIR = "attachments";

/** 文件名消毒：去掉路径分隔符与首尾点，避免穿越或隐藏文件 */
function safeFileName(name: string, index: number, mimeType: string): string {
  const base = (name || "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f<>:"|?*]/g, "").replace(/^\.+/, "").trim();
  if (clean) return clean.slice(0, 120);
  const ext = mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
  return `attachment-${index + 1}.${ext}`;
}

/**
 * 把附件字节写到会话目录下的 `attachments/`，返回轻量引用。
 *
 * 落盘失败不影响本轮请求（附件仍会内联给模型），只在返回里跳过该条；
 * 写盘用「时间戳 + 序号」前缀保证同一会话内不重名。
 */
export function saveAttachments(
  sessionDir: string,
  attachments: MessageAttachment[] | undefined,
): StoredAttachment[] {
  if (!attachments?.length) return [];
  const dir = path.join(sessionDir, ATTACHMENT_DIR);
  const prefix = Date.now().toString(36);
  const out: StoredAttachment[] = [];
  attachments.forEach((a, i) => {
    const comma = a.dataUrl.indexOf(",");
    if (comma < 0) return;
    let buf: Buffer;
    try {
      buf = Buffer.from(a.dataUrl.slice(comma + 1), "base64");
    } catch {
      return;
    }
    if (buf.length === 0) return;
    const fileName = `${prefix}-${i}-${safeFileName(a.name, i, a.mimeType)}`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, fileName), buf);
    } catch {
      return;
    }
    out.push({
      name: a.name,
      mimeType: a.mimeType,
      size: buf.length,
      path: `${ATTACHMENT_DIR}/${fileName}`,
    });
  });
  return out;
}

/**
 * 读取已落盘的附件（聊天记录里的缩略图 / 大图）。
 *
 * `relPath` 必须落在 `attachments/` 下且是单层文件名：拒绝 `..`、子目录与
 * 其它目录，避免这条只读接口被用来读会话目录里的别的东西。
 */
export function readStoredAttachment(
  sessionDir: string,
  relPath: string,
): { name: string; mimeType: string; size: number; base64: string } {
  const rel = (relPath ?? "").trim().replace(/^\/+/, "");
  const parts = rel.split("/");
  if (parts.length !== 2 || parts[0] !== ATTACHMENT_DIR) {
    throw new Error("附件路径不合法");
  }
  const file = parts[1]!;
  if (!file || file === "." || file === ".." || /[\\/]/.test(file)) {
    throw new Error("附件路径不合法");
  }
  const abs = path.join(sessionDir, ATTACHMENT_DIR, file);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    throw new Error("附件不存在");
  }
  // 展示名去掉落盘前缀（`<ts>-<i>-`）：`mex3k2-0-shot.png` → `shot.png`
  const name = file.replace(/^[a-z0-9]+-\d+-/i, "");
  const ext = path.extname(file).slice(1).toLowerCase();
  const mimeType =
    ext === "png"
      ? "image/png"
      : ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "gif"
          ? "image/gif"
          : ext === "webp"
            ? "image/webp"
            : "application/octet-stream";
  return { name, mimeType, size: buf.length, base64: buf.toString("base64") };
}

/** 剥掉所有消息上的附件（落盘 / 事件 / 会话摘要用） */
export function stripAttachments<T>(messages: T[]): T[] {
  let changed = false;
  const out = messages.map((m) => {
    const rec = m as Record<string, unknown> | null;
    if (!rec || typeof rec !== "object" || !Array.isArray(rec.attachments)) return m;
    if (rec.attachments.length === 0) return m;
    changed = true;
    const { attachments, ...rest } = rec;
    void attachments;
    return rest as T;
  });
  return changed ? out : messages;
}

/** 消息是否带非图片附件（Responses API 只支持图片，需要降级到 Chat） */
export function hasNonImageAttachments(
  messages: { attachments?: MessageAttachment[] }[],
): boolean {
  return messages.some((m) =>
    m.attachments?.some((a) => capabilityOfMime(a.mimeType) !== "image"),
  );
}
