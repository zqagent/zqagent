/**
 * 用户消息附件：校验与剥离
 *
 * 附件是 base64 data URL，必须在上行前挡住非法类型 / 超限，否则：
 *   - 供应商只会回一个看不懂的 400；
 *   - 或是 base64 进入 session.json / 事件日志，把磁盘撑爆。
 * 10MB 是链路评估后的上限（base64 后约 13.4MB，帧上限 16MB）。
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AttachmentError,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  attachmentBytes,
  hasNonImageAttachments,
  normalizeAttachments,
  readStoredAttachment,
  saveAttachments,
  stripAttachments,
} from "../src/index.js";

/** 构造一个「声明大小」为 bytes 的 data URL（内容本身不必真实） */
function dataUrl(mime: string, bytes: number): string {
  // base64 字符数 ≈ bytes * 4/3（向上取整到 4 的倍数）
  const chars = Math.ceil(bytes / 3) * 4;
  return `data:${mime};base64,${"A".repeat(chars)}`;
}

const IMG = { name: "a.png", mimeType: "image/png", dataUrl: dataUrl("image/png", 1024) };

describe("normalizeAttachments", () => {
  it("无附件 / 空数组返回 undefined", () => {
    expect(normalizeAttachments(undefined)).toBeUndefined();
    expect(normalizeAttachments(null)).toBeUndefined();
    expect(normalizeAttachments([])).toBeUndefined();
  });

  it("规范化图片附件（文件名缺省时用「图片附件」）", () => {
    expect(normalizeAttachments([IMG])).toEqual([IMG]);
    expect(normalizeAttachments([{ dataUrl: IMG.dataUrl, mimeType: "image/png" }])).toEqual([
      { name: "图片附件", mimeType: "image/png", dataUrl: IMG.dataUrl },
    ]);
  });

  it("拒绝不受支持的类型（文本/未知类型不能作为附件）", () => {
    expect(() =>
      normalizeAttachments([
        { name: "a.txt", mimeType: "text/plain", dataUrl: dataUrl("text/plain", 10) },
      ]),
    ).toThrow(AttachmentError);
  });

  it("拒绝缺少 base64 data URL 的项", () => {
    expect(() =>
      normalizeAttachments([{ name: "a.png", mimeType: "image/png", dataUrl: "https://x/a.png" }]),
    ).toThrow(AttachmentError);
  });

  it("拒绝声明的 MIME 与 data URL 内容不一致", () => {
    expect(() =>
      normalizeAttachments([{ name: "a.png", mimeType: "image/jpeg", dataUrl: IMG.dataUrl }]),
    ).toThrow(AttachmentError);
  });

  it("拒绝超过个数上限", () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => IMG);
    expect(() => normalizeAttachments(many)).toThrow(AttachmentError);
  });

  it("拒绝单个或合计超过 10MB", () => {
    expect(() =>
      normalizeAttachments([
        { name: "big.png", mimeType: "image/png", dataUrl: dataUrl("image/png", MAX_ATTACHMENT_BYTES + 1) },
      ]),
    ).toThrow(AttachmentError);

    const half = Math.ceil(MAX_ATTACHMENT_BYTES / 2) + 1024;
    expect(() =>
      normalizeAttachments([
        { name: "a.png", mimeType: "image/png", dataUrl: dataUrl("image/png", half) },
        { name: "b.png", mimeType: "image/png", dataUrl: dataUrl("image/png", half) },
      ]),
    ).toThrow(AttachmentError);
  });
});

describe("attachmentBytes", () => {
  it("按 base64 长度反推原文件字节数", () => {
    expect(attachmentBytes({ ...IMG, dataUrl: dataUrl("image/png", 3000) })).toBe(3000);
  });
});

describe("stripAttachments", () => {
  it("剥离附件且不修改原数组；无附件时原样返回", () => {
    const msgs = [
      { role: "user", content: "看图", attachments: [IMG] },
      { role: "assistant", content: "好的" },
    ];
    const out = stripAttachments(msgs);
    expect(out[0]).toEqual({ role: "user", content: "看图" });
    expect(out[1]).toBe(msgs[1]);
    // 原对象不被就地修改：引擎本轮仍要带附件发请求
    expect(msgs[0]).toHaveProperty("attachments");

    const plain = [{ role: "user", content: "hi" }];
    expect(stripAttachments(plain)).toBe(plain);
  });
});

describe("hasNonImageAttachments", () => {
  it("Responses 只支持图片：音频/视频附件需要降级 Chat", () => {
    expect(hasNonImageAttachments([{ attachments: [IMG] }])).toBe(false);
    expect(
      hasNonImageAttachments([
        { attachments: [{ name: "a.mp3", mimeType: "audio/mpeg", dataUrl: dataUrl("audio/mpeg", 10) }] },
      ]),
    ).toBe(true);
    expect(
      hasNonImageAttachments([
        { attachments: [{ name: "a.mp4", mimeType: "video/mp4", dataUrl: dataUrl("video/mp4", 10) }] },
      ]),
    ).toBe(true);
  });
});

describe("附件落盘与回读", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-attach-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("把字节写进 attachments/，消息里只留轻量引用", () => {
    const sessionDir = tmp();
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    const refs = saveAttachments(sessionDir, [
      {
        name: "shot.png",
        mimeType: "image/png",
        dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
      },
    ]);

    expect(refs).toHaveLength(1);
    expect(refs[0]!.name).toBe("shot.png");
    expect(refs[0]!.mimeType).toBe("image/png");
    expect(refs[0]!.size).toBe(bytes.length);
    expect(refs[0]!.path).toMatch(/^attachments\/.+shot\.png$/);
    expect([...fs.readFileSync(path.join(sessionDir, refs[0]!.path))]).toEqual([...bytes]);
    // 引用本身不含 base64（否则 session.json 会膨胀）
    expect(JSON.stringify(refs)).not.toContain(bytes.toString("base64"));
  });

  it("回读：按引用取回原始字节与类型", () => {
    const sessionDir = tmp();
    const bytes = Buffer.from("hello");
    const [ref] = saveAttachments(sessionDir, [
      {
        name: "a.png",
        mimeType: "image/png",
        dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
      },
    ]);
    const back = readStoredAttachment(sessionDir, ref!.path);
    expect(back.base64).toBe(bytes.toString("base64"));
    expect(back.mimeType).toBe("image/png");
    expect(back.name).toBe("a.png");
  });

  it("回读拒绝越界路径与非 attachments 目录", () => {
    const sessionDir = tmp();
    fs.writeFileSync(path.join(sessionDir, "session.json"), "{}");
    expect(() => readStoredAttachment(sessionDir, "../session.json")).toThrow();
    expect(() => readStoredAttachment(sessionDir, "attachments/../../etc/passwd")).toThrow();
    expect(() => readStoredAttachment(sessionDir, "session.json")).toThrow();
    expect(() => readStoredAttachment(sessionDir, "attachments/missing.png")).toThrow(/不存在/);
  });

  it("文件名消毒：去掉路径与隐藏前缀", () => {
    const sessionDir = tmp();
    const [ref] = saveAttachments(sessionDir, [
      {
        name: "../../.env",
        mimeType: "image/png",
        dataUrl: `data:image/png;base64,${Buffer.from([1]).toString("base64")}`,
      },
    ]);
    expect(ref!.path).toMatch(/^attachments\/[^/]+env$/);
    expect(ref!.path).not.toContain("..");
  });

  it("无附件返回空数组", () => {
    expect(saveAttachments(tmp(), undefined)).toEqual([]);
    expect(saveAttachments(tmp(), [])).toEqual([]);
  });
});
