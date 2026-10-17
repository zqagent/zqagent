/**
 * media 工具 + ffmpegRuntime 单元测试
 *
 * 覆盖：
 * - ffmpeg 参数构建（各 op、时间码换算、非法参数）——纯函数，不需要真的装 ffmpeg；
 * - ffprobe 输出压缩、校验和文件解析、归档内查找二进制；
 * - 四级降级的前两级：resolveMedia 的优先级（env → .agent/bin → PATH）
 *   与「找不到二进制」时的结构化指引（含各平台安装命令）；
 * - 路径安全：输入/输出越出工作区被拒；
 * - 端到端（本机有 ffmpeg 时才跑）：probe / thumbnail 真跑一遍。
 *
 * 注意：resolveMedia 对「平台 + 工作区」有模块级缓存，所有注入型断言前先
 * resetFfmpegCache()，且每个用例用独立临时工作区。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { ToolRegistry, registerMediaTool } from "../src/index.js";
import {
  buildFfmpegArgs,
  buildFfprobeArgs,
  parseTimecode,
  summarizeProbe,
} from "../src/tools/media.js";
import {
  findBinaryInTree,
  installHints,
  parseChecksumFile,
  resetFfmpegCache,
  resolveMedia,
} from "../src/tools/ffmpegRuntime.js";

let workspace: string;

beforeEach(() => {
  resetFfmpegCache();
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ow-media-"));
});

afterEach(() => {
  resetFfmpegCache();
  fs.rmSync(workspace, { recursive: true, force: true });
});

// =====================================================================
// 参数构建
// =====================================================================

describe("buildFfmpegArgs", () => {
  it("trim 用流拷贝，并把 to 换算成相对 ss 的时长", () => {
    const argv = buildFfmpegArgs("trim", { ss: "5", to: "15" }, { input: "in.mp4", output: "out.mp4" });
    expect(Array.isArray(argv)).toBe(true);
    expect(argv).toEqual([
      "-y",
      "-hide_banner",
      "-nostdin",
      "-ss",
      "5",
      "-i",
      "in.mp4",
      "-t",
      "10",
      "-c",
      "copy",
      "out.mp4",
    ]);
  });

  it("trim 支持 HH:MM:SS 与 duration", () => {
    const argv = buildFfmpegArgs(
      "trim",
      { ss: "00:01:00", duration: "3" },
      { input: "in.mp4", output: "out.mp4" },
    );
    expect(Array.isArray(argv)).toBe(true);
    expect(argv).toContain("-t");
    expect(argv[argv.indexOf("-t") + 1]).toBe("3");
    expect(argv[argv.indexOf("-ss") + 1]).toBe("60");
  });

  it("trim：to 不大于 ss 时报错", () => {
    const argv = buildFfmpegArgs("trim", { ss: "5", to: "5" }, { input: "a.mp4", output: "b.mp4" });
    expect(argv).toMatchObject({ error: expect.stringContaining("必须大于") });
  });

  it("非法时间码报错", () => {
    const argv = buildFfmpegArgs("trim", { ss: "abc" }, { input: "a.mp4", output: "b.mp4" });
    expect(argv).toMatchObject({ error: expect.stringContaining("ss") });
  });

  it("convert：只给宽度时按比例自适应高度", () => {
    const argv = buildFfmpegArgs("convert", { width: 640 }, { input: "a.mov", output: "b.mp4" });
    expect(Array.isArray(argv)).toBe(true);
    expect(argv[argv.indexOf("-vf") + 1]).toBe("scale=640:-2");
  });

  it("extract_audio 丢弃视频流", () => {
    const argv = buildFfmpegArgs("extract_audio", {}, { input: "a.mp4", output: "a.mp3" });
    expect(Array.isArray(argv)).toBe(true);
    expect(argv).toContain("-vn");
  });

  it("extract_frame 只取一帧；thumbnail 默认压到 320 宽", () => {
    const frame = buildFfmpegArgs("extract_frame", { ss: 2 }, { input: "a.mp4", output: "f.png" });
    expect(Array.isArray(frame)).toBe(true);
    expect(frame[frame.indexOf("-frames:v") + 1]).toBe("1");
    expect(frame).not.toContain("-vf");

    const thumb = buildFfmpegArgs("thumbnail", { ss: 2 }, { input: "a.mp4", output: "t.png" });
    expect(Array.isArray(thumb)).toBe(true);
    expect(thumb[thumb.indexOf("-vf") + 1]).toBe("scale=320:-2");
  });

  it("compress 默认 CRF 28 + medium，preset 非法报错", () => {
    const argv = buildFfmpegArgs("compress", {}, { input: "a.mov", output: "b.mp4" });
    expect(Array.isArray(argv)).toBe(true);
    expect(argv[argv.indexOf("-crf") + 1]).toBe("28");
    expect(argv[argv.indexOf("-preset") + 1]).toBe("medium");

    const bad = buildFfmpegArgs("compress", { preset: "turbo" }, { input: "a.mov", output: "b.mp4" });
    expect(bad).toMatchObject({ error: expect.stringContaining("preset") });
  });

  it("未知操作报错", () => {
    const argv = buildFfmpegArgs("teleport", {}, { input: "a", output: "b" });
    expect(argv).toMatchObject({ error: expect.stringContaining("未知操作") });
  });
});

describe("ffprobe 辅助", () => {
  it("parseTimecode 支持秒数与 HH:MM:SS", () => {
    expect(parseTimecode("12.5")).toBe(12.5);
    expect(parseTimecode("00:12.5")).toBe(12.5);
    expect(parseTimecode("01:00:00")).toBe(3600);
    expect(parseTimecode("1:2:3")).toBe(3723);
    expect(parseTimecode("nope")).toBeNull();
    expect(parseTimecode(-1)).toBeNull();
  });

  it("buildFfprobeArgs 走 JSON 输出", () => {
    const argv = buildFfprobeArgs("a.mp4");
    expect(argv).toContain("-print_format");
    expect(argv[argv.length - 1]).toBe("a.mp4");
  });

  it("summarizeProbe 只保留模型关心的字段", () => {
    const out = summarizeProbe({
      format: { format_name: "mov,mp4", duration: "2.500000", size: "1234", bit_rate: "4000" },
      streams: [
        { index: 0, codec_type: "video", codec_name: "h264", width: 320, height: 240, avg_frame_rate: "10/1" },
        { index: 1, codec_type: "audio", codec_name: "aac", sample_rate: "44100", channels: 1 },
      ],
      junk: "x".repeat(1000),
    });
    expect(out.format).toMatchObject({ format_name: "mov,mp4", duration_sec: 2.5, size_bytes: 1234 });
    expect(out.streams).toHaveLength(2);
    expect(out.streams[0]).toMatchObject({ type: "video", width: 320, height: 240 });
    expect(out.streams[1]).toMatchObject({ type: "audio", sample_rate: 44100, channels: 1 });
    expect(out).not.toHaveProperty("junk");
  });
});

// =====================================================================
// 下载辅助
// =====================================================================

describe("ffmpegRuntime 下载辅助", () => {
  it("parseChecksumFile 支持单行、纯 hash 与多行按文件名匹配", () => {
    expect(parseChecksumFile("7fa72b652e19bf84c9461e332ea1cdf3  a.tar.xz", "a.tar.xz")).toBe(
      "7fa72b652e19bf84c9461e332ea1cdf3",
    );
    expect(parseChecksumFile("7FA72B652E19BF84C9461E332EA1CDF3", "a.tar.xz")).toBe(
      "7fa72b652e19bf84c9461e332ea1cdf3",
    );
    const multi = ["aaa  other.zip", `${"b".repeat(64)}  wanted.zip`].join("\n");
    expect(parseChecksumFile(multi, "wanted.zip")).toBe("b".repeat(64));
    expect(parseChecksumFile("", "wanted.zip")).toBeNull();
  });

  it("findBinaryInTree 递归查找（各家归档层级不同）", () => {
    const deep = path.join(workspace, "pkg", "bin", "inner");
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, "ffmpeg"), "x");
    expect(findBinaryInTree(workspace, ["ffmpeg", "ffmpeg.exe"])).toBe(path.join(deep, "ffmpeg"));
    expect(findBinaryInTree(workspace, ["ffprobe"])).toBeNull();
  });

  it("installHints 给出各平台可直接执行的命令", () => {
    expect(installHints("darwin")[0]).toContain("brew install ffmpeg");
    expect(installHints("win32").join(" ")).toContain("winget install");
    expect(installHints("linux").join(" ")).toContain("apt-get install -y ffmpeg");
  });
});

// =====================================================================
// 定位优先级（四级降级第 1 级）
// =====================================================================

describe("resolveMedia 定位优先级", () => {
  const never = () => false;

  it("全都没有时返回 null", () => {
    const r = resolveMedia(workspace, { platform: "linux", env: { PATH: "" }, fileExists: never });
    expect(r).toEqual({ ffmpeg: null, ffprobe: null });
  });

  it("环境变量优先于 .agent/bin 与 PATH", () => {
    const env = {
      PATH: "/usr/bin",
      ZQAGENT_FFMPEG: "/opt/ff/ffmpeg",
      ZQAGENT_FFPROBE: "/opt/ff/ffprobe",
    };
    const r = resolveMedia(workspace, { platform: "linux", env, fileExists: () => true });
    expect(r.ffmpeg).toMatchObject({ path: "/opt/ff/ffmpeg", source: "env" });
    expect(r.ffprobe).toMatchObject({ path: "/opt/ff/ffprobe", source: "env" });
  });

  it("其次是工作区 .agent/bin", () => {
    const local = path.join(workspace, ".agent", "bin", "ffmpeg");
    const r = resolveMedia(workspace, {
      platform: "linux",
      env: { PATH: "" },
      fileExists: (p) => p === local,
    });
    expect(r.ffmpeg).toMatchObject({ path: local, source: "agent-bin" });
    expect(r.ffprobe).toBeNull();
  });

  it("最后回退到 PATH", () => {
    const r = resolveMedia(workspace, {
      platform: "linux",
      env: { PATH: "/usr/local/bin:/usr/bin" },
      fileExists: (p) => p === "/usr/bin/ffmpeg",
    });
    expect(r.ffmpeg).toMatchObject({ path: "/usr/bin/ffmpeg", source: "path" });
  });

  it("Windows 下 .agent/bin 里的名字带 .exe", () => {
    const local = path.join(workspace, ".agent", "bin", "ffmpeg.exe");
    const r = resolveMedia(workspace, {
      platform: "win32",
      env: { PATH: "C:\\bin" },
      fileExists: (p) => p === local,
    });
    expect(r.ffmpeg).toMatchObject({ path: local, source: "agent-bin" });
  });
});

// =====================================================================
// 工具行为
// =====================================================================

/** 造一个「能找到假 ffmpeg」的注册环境（不会真的执行到外部进程） */
function registerWithFakeBinary(): ToolRegistry {
  const registry = new ToolRegistry();
  registerMediaTool(registry, workspace, {
    platform: "linux",
    env: { PATH: "" },
    fileExists: () => true,
  });
  return registry;
}

describe("media 工具", () => {
  it("缺少 op / 未知 op 时给出可选值", async () => {
    const registry = registerWithFakeBinary();
    const missing = (await registry.execute("media", {})) as Record<string, unknown>;
    expect(missing.error).toContain("缺少参数 op");

    const unknown = (await registry.execute("media", { op: "teleport" })) as Record<string, unknown>;
    expect(unknown.error).toContain("未知操作");
    expect(unknown.error).toContain("thumbnail");
  });

  it("找不到二进制时返回四级降级指引，而不是单纯报错", async () => {
    const registry = new ToolRegistry();
    registerMediaTool(registry, workspace, {
      platform: "linux",
      env: { PATH: "" },
      fileExists: () => false,
    });
    const r = (await registry.execute("media", { op: "probe", input: "a.mp4" })) as Record<
      string,
      unknown
    >;
    expect(r.error).toContain("未找到 ffprobe");
    expect(r.how_to_fix).toBeInstanceOf(Array);
    expect((r.how_to_fix as string[]).join(" ")).toContain('op="setup"');
    expect((r.install_commands as string[]).join(" ")).toContain("apt-get install -y ffmpeg");
    // 提示 run_shell 的坑：装完要重启进程
    expect((r.notes as string[]).join(" ")).toContain("重启 agent 进程");
  });

  it("setup 在二进制已可用时直接返回，不发起下载", async () => {
    const registry = registerWithFakeBinary();
    const r = (await registry.execute("media", { op: "setup" })) as Record<string, unknown>;
    expect(r).toMatchObject({ ok: true, already_available: true });
  });

  it("缺 input / output 时明确报错", async () => {
    const registry = registerWithFakeBinary();
    const noInput = (await registry.execute("media", { op: "trim" })) as Record<string, unknown>;
    expect(noInput.error).toContain("需要参数 input");

    fs.writeFileSync(path.join(workspace, "a.mp4"), "not really a video");
    const noOutput = (await registry.execute("media", {
      op: "trim",
      input: "a.mp4",
    })) as Record<string, unknown>;
    expect(noOutput.error).toContain("需要参数 output");
  });

  it("输入越出工作区被拒（symlink 也拦得住）", async () => {
    const registry = registerWithFakeBinary();
    const r = (await registry.execute("media", {
      op: "trim",
      input: "../outside.mp4",
      output: "o.mp4",
    })) as Record<string, unknown>;
    expect(r.error).toContain("不在工作区内");

    // 工作区内 symlink 指向外部 → realpath 解析后同样被拒
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ow-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.mp4"), "x");
      fs.symlinkSync(outside, path.join(workspace, "link"));
      const viaLink = (await registry.execute("media", {
        op: "trim",
        input: "link/secret.mp4",
        output: "o.mp4",
      })) as Record<string, unknown>;
      expect(viaLink.error).toContain("不在工作区内");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("输入文件不存在时报错", async () => {
    const registry = registerWithFakeBinary();
    const r = (await registry.execute("media", {
      op: "probe",
      input: "missing.mp4",
    })) as Record<string, unknown>;
    expect(r.error).toContain("输入文件不存在");
  });

  it("工具元数据要求审批、风险等级 medium", () => {
    const registry = new ToolRegistry();
    registerMediaTool(registry, workspace);
    const spec = registry.get("media")!;
    expect(spec.metadata.category).toBe("media");
    expect(spec.metadata.riskLevel).toBe("medium");
    expect(spec.metadata.requiresApproval).toBe(true);
    expect(spec.schema.function.name).toBe("media");
  });
});

// =====================================================================
// 端到端（本机有 ffmpeg 才跑）
// =====================================================================

function systemFfmpeg(): boolean {
  try {
    return spawnSync("ffmpeg", ["-version"], { encoding: "utf-8", timeout: 15000 }).status === 0;
  } catch {
    return false;
  }
}

describe.skipIf(!systemFfmpeg())("media 工具端到端（需本机 ffmpeg）", () => {
  beforeEach(() => {
    // 造一段 1 秒的测试视频（mpeg4/png 都是 ffmpeg 内置编码器，不依赖外部库）
    const gen = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=320x240:rate=10",
        "-t",
        "1",
        "-c:v",
        "mpeg4",
        "clip.mp4",
      ],
      { cwd: workspace, encoding: "utf-8", timeout: 60000 },
    );
    if (gen.status !== 0) throw new Error(`生成测试视频失败: ${gen.stderr}`);
  });

  it("probe 返回时长与视频流", async () => {
    const registry = new ToolRegistry();
    registerMediaTool(registry, workspace);
    const r = (await registry.execute("media", { op: "probe", input: "clip.mp4" })) as Record<
      string,
      any
    >;
    expect(r.error).toBeUndefined();
    expect(r.format.duration_sec).toBeGreaterThan(0.5);
    expect(r.streams[0]).toMatchObject({ type: "video", width: 320, height: 240 });
  });

  it("thumbnail 生成缩略图文件", async () => {
    const registry = new ToolRegistry();
    registerMediaTool(registry, workspace);
    const r = (await registry.execute("media", {
      op: "thumbnail",
      input: "clip.mp4",
      output: "thumb.png",
      ss: 0.5,
    })) as Record<string, unknown>;
    expect(r.error).toBeUndefined();
    expect(r.size_bytes as number).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(workspace, "thumb.png"))).toBe(true);
  });

  it("trim 裁剪出更短的片段（probe 复核）", async () => {
    const registry = new ToolRegistry();
    registerMediaTool(registry, workspace);
    const cut = (await registry.execute("media", {
      op: "trim",
      input: "clip.mp4",
      output: "cut.mp4",
      ss: 0,
      duration: 0.3,
    })) as Record<string, unknown>;
    expect(cut.error).toBeUndefined();
    const probed = (await registry.execute("media", { op: "probe", input: "cut.mp4" })) as Record<
      string,
      any
    >;
    expect(probed.format.duration_sec).toBeLessThan(0.9);
  });
});
