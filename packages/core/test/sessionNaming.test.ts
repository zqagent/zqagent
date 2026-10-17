/**
 * 会话命名元数据逻辑单测（src/cli/sessionMeta.ts）
 *
 * 覆盖：
 *   1. shouldAutoName：第 1/3/5 次触发、其它不触发、用户改名后不触发；
 *   2. sanitizeSessionName：引号/前缀剥离、取首行、超长截断、空值；
 *   3. updateSessionMetaFile：读-改-写合并 name 且保留原字段、文件不存在返回 false；
 *   4. FileLogHook.saveState(engine, meta)：meta 字段写入 state。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  shouldAutoName,
  sanitizeSessionName,
  updateSessionMetaFile,
} from "../src/cli/sessionMeta.js";
import { FileLogHook } from "../src/engine/FileLogHook.js";
import type { TurnEngine } from "../src/engine/TurnEngine.js";

describe("shouldAutoName", () => {
  it("第 1/3/5 次任务完成后触发", () => {
    expect(shouldAutoName(1)).toBe(true);
    expect(shouldAutoName(3)).toBe(true);
    expect(shouldAutoName(5)).toBe(true);
  });

  it("第 2/4/6 次不触发", () => {
    expect(shouldAutoName(2)).toBe(false);
    expect(shouldAutoName(4)).toBe(false);
    expect(shouldAutoName(6)).toBe(false);
  });

  it("用户手动改名后（nameSource=user）永不再触发", () => {
    expect(shouldAutoName(1, "user")).toBe(false);
    expect(shouldAutoName(3, "user")).toBe(false);
    expect(shouldAutoName(5, "user")).toBe(false);
  });

  it("自动生成来源（nameSource=auto）仍可被覆盖", () => {
    expect(shouldAutoName(3, "auto")).toBe(true);
    expect(shouldAutoName(5, "auto")).toBe(true);
  });
});

describe("sanitizeSessionName", () => {
  it("普通文本原样返回并去空白", () => {
    expect(sanitizeSessionName("  修复登录超时  ")).toBe("修复登录超时");
  });

  it("取首行，忽略后续解释", () => {
    expect(sanitizeSessionName("修复登录超时\n这是补充说明")).toBe(
      "修复登录超时",
    );
  });

  it("剥离首尾引号/书名号", () => {
    expect(sanitizeSessionName('"修复登录超时"')).toBe("修复登录超时");
    expect(sanitizeSessionName("「修复登录超时」")).toBe("修复登录超时");
    expect(sanitizeSessionName("《修复登录超时》")).toBe("修复登录超时");
  });

  it("剥离「会话名称：」前缀", () => {
    expect(sanitizeSessionName("会话名称：修复登录超时")).toBe("修复登录超时");
    expect(sanitizeSessionName("名称: 修复登录超时")).toBe("修复登录超时");
  });

  it("超长截断到 30 字", () => {
    const long = "这是一个非常非常非常非常非常非常非常非常非常非常非常长的会话名称";
    const out = sanitizeSessionName(long);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(30);
  });

  it("空值返回 null", () => {
    expect(sanitizeSessionName(null)).toBeNull();
    expect(sanitizeSessionName(undefined)).toBeNull();
    expect(sanitizeSessionName("")).toBeNull();
    expect(sanitizeSessionName("   ")).toBeNull();
    expect(sanitizeSessionName('""')).toBeNull();
  });
});

describe("updateSessionMetaFile", () => {
  function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "ow-session-meta-"));
  }

  it("合并 name 并保留原有字段", () => {
    const dir = makeTempDir();
    const sid = "abc123";
    const file = path.join(dir, `${sid}_state.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        sessionId: sid,
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        compaction: null,
        savedAt: "2026-10-10T00:00:00.000Z",
      }),
      "utf8",
    );

    const ok = updateSessionMetaFile(dir, sid, {
      name: "测试会话",
      nameSource: "auto",
    });
    expect(ok).toBe(true);

    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(state.name).toBe("测试会话");
    expect(state.nameSource).toBe("auto");
    expect(state.model).toBe("gpt-4o");
    expect(state.messages).toHaveLength(1);
  });

  it("文件不存在返回 false", () => {
    const dir = makeTempDir();
    expect(updateSessionMetaFile(dir, "missing", { name: "x" })).toBe(false);
  });
});

describe("FileLogHook.saveState 合并命名元数据", () => {
  it("meta 字段写入 state", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-filehook-"));
    const sid = "xyz789";
    const hook = new FileLogHook(sid, dir);

    // 用最小 stub 满足 saveState 对 engine 的访问
    const engineStub = {
      model: "gpt-4o",
      messages: [],
      compactionState: null,
    } as unknown as TurnEngine;

    hook.saveState(engineStub, {
      name: "会话A",
      nameSource: "user",
      taskCount: 3,
    });

    const loaded = FileLogHook.loadState(sid, dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("会话A");
    expect(loaded!.nameSource).toBe("user");
    expect(loaded!.taskCount).toBe(3);
  });

  it("不传 meta 时字段为 undefined（向后兼容）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-filehook-"));
    const sid = "xyz790";
    const hook = new FileLogHook(sid, dir);
    const engineStub = {
      model: "gpt-4o",
      messages: [],
      compactionState: null,
    } as unknown as TurnEngine;

    hook.saveState(engineStub);
    const loaded = FileLogHook.loadState(sid, dir);
    expect(loaded!.name).toBeUndefined();
    expect(loaded!.nameSource).toBeUndefined();
    expect(loaded!.taskCount).toBeUndefined();
  });
});
