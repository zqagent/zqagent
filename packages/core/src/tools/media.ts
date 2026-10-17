/**
 * 媒体处理工具（ffmpeg / ffprobe 封装）
 *
 * 一个工具覆盖常见音视频操作：探元数据、裁剪、转码、抽音轨、抽帧、缩略图、压缩。
 * 外部二进制一律通过异步 execAsync + 参数数组调用（不经 shell），路径写入前用
 * isWithinRoot 校验，避免 symlink 逃逸。
 *
 * ffmpeg 缺失时按「四级降级」返回结构化指引，而不是直接报错：
 *   1. PATH / 环境变量 / .agent/bin / SEA 内嵌（见 ffmpegRuntime.resolveMedia）；
 *   2. op="setup" 由本工具下载官方静态构建到 <workspace>/.agent/bin；
 *   3. 引导模型改用 run_shell 安装（需用户审批）；
 *   4. 返回各平台精确的安装命令 / 下载页。
 *
 * 之所以把 2 做成显式的 op 而不是静默自动下载：一次几十 MB 的下载写入工作区，
 * 必须是用户明确发起、经过审批的动作（权限引擎对 needsUser 的工具每次弹审批）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ToolRegistry } from "./ToolRegistry.js";
import { execAsync } from "./execAsync.js";
import { decodeOutput } from "./shell.js";
import { resolveWithinRoot } from "./pathSafety.js";
import {
  canAutoDownload,
  downloadFfmpeg,
  installHints,
  resolveMedia,
  type ResolvedBin,
} from "./ffmpegRuntime.js";

/** 输出截断上限（字符） */
const MAX_OUTPUT = 4000;
/** 单次转码超时（毫秒）——与 shell 工具的上限保持一致 */
const TIMEOUT_MS = 600 * 1000;
/** 输出缓冲上限（字节） */
const MAX_BUFFER = 1024 * 1024 * 8;

/** 需要输入文件的操作 */
const NEEDS_INPUT = new Set([
  "probe",
  "trim",
  "convert",
  "extract_audio",
  "extract_frame",
  "thumbnail",
  "compress",
]);

/** 会产生输出文件的操作 */
const NEEDS_OUTPUT = new Set([
  "trim",
  "convert",
  "extract_audio",
  "extract_frame",
  "thumbnail",
  "compress",
]);

const OPS = [
  "probe",
  "trim",
  "convert",
  "extract_audio",
  "extract_frame",
  "thumbnail",
  "compress",
  "setup",
] as const;

/** 允许的 x264 preset（挡掉拼错的值，避免模型拿到晦涩的 ffmpeg 报错） */
const PRESETS = new Set([
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow",
]);

// =====================================================================
// 参数解析辅助
// =====================================================================

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return undefined;
}

function finiteNum(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "string" ? Number(v.trim()) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/** 解析时间码：秒数、`MM:SS`、`HH:MM:SS(.mmm)` 都接受；非法返回 null */
export function parseTimecode(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "") return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const parts = t.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  let sec = 0;
  for (const p of parts) {
    if (!/^\d+(\.\d+)?$/.test(p)) return null;
    sec = sec * 60 + Number(p);
  }
  return sec;
}

/** 截断到末尾 max 个字符（对齐 shell 工具：报错信息通常在末尾） */
function truncateTail(s: string, max = MAX_OUTPUT): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `…（已截断前 ${t.length - max} 字符）\n` + t.slice(-max);
}

// =====================================================================
// ffmpeg / ffprobe 参数构建（纯函数，便于单测）
// =====================================================================

export interface BuildPaths {
  /** 已解析为绝对路径的输入 */
  input?: string;
  /** 已解析为绝对路径的输出 */
  output?: string;
}

/** 缩放滤镜：宽或高留空表示按比例自适应 */
function scaleFilter(width?: number | null, height?: number | null): string | null {
  if (width && height) return `scale=${width}:${height}`;
  if (width) return `scale=${width}:-2`;
  if (height) return `scale=-2:${height}`;
  return null;
}

/**
 * 构建 ffmpeg 参数数组。
 *
 * @returns 参数数组；参数不合法时返回 { error }
 */
export function buildFfmpegArgs(
  op: string,
  args: Record<string, unknown>,
  paths: BuildPaths,
): string[] | { error: string } {
  const input = paths.input ?? "";
  // -y 覆盖输出、-hide_banner 精简日志、-nostdin 防止 ffmpeg 抢 stdin（spawnSync 无 tty）
  const argv: string[] = ["-y", "-hide_banner", "-nostdin"];

  const ss = args["ss"] === undefined ? null : parseTimecode(args["ss"]);
  if (args["ss"] !== undefined && ss === null) {
    return { error: "参数 ss 不是合法时间码（示例：12.5 / 00:12.5 / 00:00:12.5）" };
  }
  const to = args["to"] === undefined ? null : parseTimecode(args["to"]);
  if (args["to"] !== undefined && to === null) {
    return { error: "参数 to 不是合法时间码（示例：30 / 00:30 / 00:00:30）" };
  }
  const duration = args["duration"] === undefined ? null : finiteNum(args["duration"], 0, 24 * 3600);
  if (args["duration"] !== undefined && duration === null) {
    return { error: "参数 duration 必须是 0～86400 之间的秒数" };
  }
  if (to !== null && ss !== null && to <= ss) {
    return { error: `参数 to (${to}s) 必须大于 ss (${ss}s)` };
  }

  const output = paths.output ?? "";
  const format = str(args["format"]);

  switch (op) {
    case "trim": {
      // 流拷贝裁剪：快且无损，但切点会对齐到关键帧
      if (ss !== null) argv.push("-ss", String(ss));
      argv.push("-i", input);
      // -t 相对已定位的起点；to 与 ss 同时给出时换算成时长，语义更确定
      if (duration !== null) {
        argv.push("-t", String(duration));
      } else if (to !== null) {
        argv.push("-t", String(to - (ss ?? 0)));
      }
      argv.push("-c", "copy");
      if (format) argv.push("-f", format);
      argv.push(output);
      return argv;
    }

    case "convert": {
      argv.push("-i", input);
      const vf = scaleFilter(
        args["width"] === undefined ? null : finiteNum(args["width"], 1, 16384),
        args["height"] === undefined ? null : finiteNum(args["height"], 1, 16384),
      );
      if (vf) argv.push("-vf", vf);
      const fps = args["fps"] === undefined ? null : finiteNum(args["fps"], 0.01, 240);
      if (fps !== null) argv.push("-r", String(fps));
      const codec = str(args["codec"]);
      if (codec) argv.push("-c:v", codec);
      const bitrate = str(args["bitrate"]);
      if (bitrate) argv.push("-b:v", bitrate);
      if (format) argv.push("-f", format);
      argv.push(output);
      return argv;
    }

    case "extract_audio": {
      argv.push("-i", input, "-vn");
      const codec = str(args["codec"]);
      if (codec) argv.push("-c:a", codec);
      const bitrate = str(args["bitrate"]);
      if (bitrate) argv.push("-b:a", bitrate);
      if (format) argv.push("-f", format);
      argv.push(output);
      return argv;
    }

    case "extract_frame":
    case "thumbnail": {
      const at = ss ?? 0;
      argv.push("-ss", String(at), "-i", input, "-frames:v", "1");
      const width = args["width"] === undefined ? null : finiteNum(args["width"], 1, 16384);
      const height = args["height"] === undefined ? null : finiteNum(args["height"], 1, 16384);
      // 缩略图默认压到 320 宽；抽帧默认保持原尺寸
      const vf = scaleFilter(op === "thumbnail" ? (width ?? 320) : width, height);
      if (vf) argv.push("-vf", vf);
      if (format) argv.push("-f", format);
      argv.push(output);
      return argv;
    }

    case "compress": {
      const quality = args["quality"] === undefined ? 28 : finiteNum(args["quality"], 0, 51);
      if (quality === null) return { error: "参数 quality 必须是 0～51 之间的数字（越大越糊、越小越清晰）" };
      const preset = str(args["preset"]) ?? "medium";
      if (!PRESETS.has(preset)) {
        return { error: `参数 preset 不合法，可选：${[...PRESETS].join(" / ")}` };
      }
      argv.push("-i", input);
      const vf = scaleFilter(
        args["width"] === undefined ? null : finiteNum(args["width"], 1, 16384),
        args["height"] === undefined ? null : finiteNum(args["height"], 1, 16384),
      );
      if (vf) argv.push("-vf", vf);
      argv.push("-c:v", "libx264", "-crf", String(quality), "-preset", preset, "-c:a", "aac", "-b:a", "128k");
      if (format) argv.push("-f", format);
      argv.push(output);
      return argv;
    }

    default:
      return { error: `未知操作: ${op}` };
  }
}

/** ffprobe 参数：只输出需要的字段，避免超大 JSON */
export function buildFfprobeArgs(input: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", input];
}

/** 把 ffprobe 的原始 JSON 压成模型易读的结构（体积可控） */
export function summarizeProbe(raw: unknown): Record<string, unknown> {
  const o = (raw ?? {}) as Record<string, any>;
  const fmt = (o["format"] ?? {}) as Record<string, any>;
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const streams = Array.isArray(o["streams"]) ? o["streams"] : [];
  return {
    format: {
      format_name: fmt["format_name"],
      duration_sec: num(fmt["duration"]),
      size_bytes: num(fmt["size"]),
      bit_rate: num(fmt["bit_rate"]),
    },
    streams: streams.map((s: Record<string, any>) => ({
      index: s["index"],
      type: s["codec_type"],
      codec: s["codec_name"],
      profile: s["profile"],
      width: s["width"],
      height: s["height"],
      fps: s["avg_frame_rate"] ?? s["r_frame_rate"],
      sample_rate: num(s["sample_rate"]),
      channels: s["channels"],
    })),
  };
}

// =====================================================================
// 缺失二进制的降级指引
// =====================================================================

/**
 * 组装「找不到 ffmpeg」时的结构化错误。
 *
 * 第 1 级已经失败（调用方才走到这里），因此给出 2/3/4 级的具体做法。
 */
function missingGuidance(
  missing: string,
  op: string,
  platform: NodeJS.Platform,
  arch: string,
): Record<string, unknown> {
  const hints = installHints(platform);
  const howToFix: string[] = [];

  if (canAutoDownload(platform, arch)) {
    howToFix.push(
      `本工具自动下载：改用 op="setup"（下载官方静态构建到 .agent/bin，需要出网；一次即可，之后一直可用）。`,
    );
  } else {
    howToFix.push(`当前平台 (${platform}/${arch}) 没有自动下载源，请用下面两种方式之一。`);
  }
  howToFix.push(
    `改用 run_shell 安装（需用户审批）：先执行 ${JSON.stringify(hints[0])}；这只在本机交互式使用时可行，服务端/Docker 无法提权。`,
  );
  howToFix.push(
    `用户手工安装后，把可执行文件路径写入环境变量 ZQAGENT_FFMPEG / ZQAGENT_FFPROBE，或放进 <workspace>/.agent/bin。`,
  );

  return {
    error: `未找到 ${missing}，操作 ${op} 无法执行（ffmpeg 未安装或不在所有已知位置）。`,
    searched: [
      `环境变量 ZQAGENT_${missing.toUpperCase()}`,
      `<workspace>/.agent/bin/${missing}`,
      "SEA 单文件内嵌资源",
      "PATH",
    ],
    how_to_fix: howToFix,
    install_commands: hints,
    notes: [
      "run_shell 的每次调用不保留环境变量（导出 PATH 只在当次有效），装完必须让用户重启 agent 进程才能被发现。",
      "ffmpeg 静态构建多为 GPL/LGPL 许可，随产品分发前请确认源码提供义务。",
    ],
  };
}

// =====================================================================
// 工具注册
// =====================================================================

/** 注册选项：可注入平台/环境/文件探测，便于在测试中演练降级路径 */
export interface MediaToolOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fileExists?: (p: string) => boolean;
}

interface RunOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  /** 超时被终止（异步 execAsync 下不再走 error.code === "ETIMEDOUT"） */
  timedOut: boolean;
}

async function runBinary(bin: string, argv: string[], cwd: string): Promise<RunOutcome> {
  const res = await execAsync(bin, argv, {
    cwd,
    timeoutMs: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  return {
    status: res.status,
    stdout: decodeOutput(res.stdout),
    stderr: decodeOutput(res.stderr),
    error: res.error ?? undefined,
    timedOut: res.timedOut,
  };
}

/** 把工作区相对路径解析为绝对真实路径，并校验不逃出工作区 */
function resolveTarget(
  workspace: string,
  value: string,
): { abs: string; root: string } | { error: string } {
  const resolved = resolveWithinRoot(workspace, value);
  if (!resolved) {
    return { error: `路径不在工作区内（已拒绝）: ${value}` };
  }
  return { abs: resolved.real, root: resolved.root };
}

function relOut(workspace: string, abs: string): string {
  return path.relative(workspace, abs) || abs;
}

export function registerMediaTool(
  registry: ToolRegistry,
  workspace: string,
  opts: MediaToolOptions = {},
): void {
  const platform = opts.platform ?? process.platform;
  const arch = process.arch;
  const media = async (args: Record<string, unknown>): Promise<unknown> => {
    const root = path.resolve(workspace);
    const op = str(args["op"]);

    if (!op) {
      return { error: `缺少参数 op。可选值：${OPS.join(" / ")}` };
    }
    if (!(OPS as readonly string[]).includes(op)) {
      return { error: `未知操作 ${JSON.stringify(op)}。可选值：${OPS.join(" / ")}` };
    }

    const bins = resolveMedia(root, opts);
    // probe 只需 ffprobe，其余操作需要 ffmpeg
    const needed: "ffmpeg" | "ffprobe" = op === "probe" ? "ffprobe" : "ffmpeg";

    // ---- 第 2 级：显式下载安装 ----
    if (op === "setup") {
      const already: ResolvedBin | null = bins[needed];
      if (already) {
        return {
          ok: true,
          already_available: true,
          path: already.path,
          source: already.source,
          message: "ffmpeg 已可用，无需下载。",
        };
      }
      const res = await downloadFfmpeg(root, {});
      if (!res.ok) {
        return {
          ...missingGuidance("ffmpeg", "setup", platform, arch),
          error: `自动下载失败：${res.error ?? "未知原因"}`,
        };
      }
      return {
        ok: true,
        installed: res.installed,
        notes: res.notes,
        message: "已安装到 .agent/bin，后续 media 调用会直接使用它。",
      };
    }

    // ---- 第 1 级失败 → 第 3/4 级指引 ----
    if (!bins[needed]) {
      return missingGuidance(needed, op, platform, arch);
    }

    // ---- 输入 / 输出路径 ----
    let inputAbs: string | undefined;
    // 展示用相对路径的基准：与解析出的真实路径配套，避免根目录含符号链接时算出错误相对路径
    let relRoot = root;
    if (NEEDS_INPUT.has(op)) {
      const input = str(args["input"]);
      if (!input) return { error: `操作 ${op} 需要参数 input（工作区内相对路径）` };
      const r = resolveTarget(root, input);
      if ("error" in r) return { error: r.error };
      if (!fs.existsSync(r.abs) || !fs.statSync(r.abs).isFile()) {
        return { error: `输入文件不存在: ${input}` };
      }
      inputAbs = r.abs;
      relRoot = r.root;
    }

    let outputAbs: string | undefined;
    if (NEEDS_OUTPUT.has(op)) {
      const output = str(args["output"]);
      if (!output) return { error: `操作 ${op} 需要参数 output（工作区内相对路径）` };
      const r = resolveTarget(root, output);
      if ("error" in r) return { error: r.error };
      // 输出目录通常由模型拼路径时漏建，这里补上（仍在校验过的工作区内）
      fs.mkdirSync(path.dirname(r.abs), { recursive: true });
      outputAbs = r.abs;
      relRoot = r.root;
    }

    // ---- probe：走 ffprobe，返回结构化元数据 ----
    if (op === "probe") {
      const out = await runBinary(bins.ffprobe!.path, buildFfprobeArgs(inputAbs!), root);
      if (out.error) return { error: `执行 ffprobe 失败: ${out.error.message}` };
      if (out.timedOut) {
        return { error: `ffprobe 超时（${TIMEOUT_MS / 1000}s）后已终止` };
      }
      if (out.status !== 0 && !out.stdout.trim()) {
        return { error: `ffprobe 退出码 ${out.status}`, stderr: truncateTail(out.stderr) };
      }
      try {
        return {
          ok: true,
          input: relOut(relRoot, inputAbs!),
          ...summarizeProbe(JSON.parse(out.stdout)),
        };
      } catch {
        return { error: "ffprobe 输出不是合法 JSON", stdout: truncateTail(out.stdout) };
      }
    }

    // ---- 其余操作：构建参数并执行 ffmpeg ----
    const built = buildFfmpegArgs(op, args, { input: inputAbs, output: outputAbs });
    if (!Array.isArray(built)) return built;

    const out = await runBinary(bins.ffmpeg!.path, built, root);
    if (out.error) {
      return {
        error: `执行 ffmpeg 失败: ${out.error.message}`,
      };
    }
    // 超时不带 status，单独说清楚，避免模型反复重试同一个大文件
    if (out.timedOut) {
      return {
        error: `ffmpeg 超过 ${TIMEOUT_MS / 1000} 秒未完成，已终止`,
        hint: "可考虑用更短的片段或 gpu 编码",
      };
    }
    if (out.status !== 0) {
      return {
        error: `ffmpeg 退出码 ${out.status}`,
        stderr: truncateTail(out.stderr),
      };
    }

    const result: Record<string, unknown> = {
      ok: true,
      op,
      output: outputAbs ? relOut(relRoot, outputAbs) : undefined,
    };
    if (outputAbs) {
      try {
        result["size_bytes"] = fs.statSync(outputAbs).size;
      } catch {
        // 极少数操作（如只写日志）可能没有输出文件，忽略
      }
    }
    if (out.stderr.trim()) result["ffmpeg_log"] = truncateTail(out.stderr);
    return result;
  };

  registry.register(
    media,
    {
      category: "media",
      riskLevel: "medium",
      capabilities: ["ffmpeg 音视频处理：探元数据、裁剪、转码、抽音轨、抽帧、缩略图、压缩"],
      // 会调用外部二进制并写文件，且 op="setup" 还会下载安装；一律弹审批
      requiresApproval: true,
    },
    {
      type: "function",
      function: {
        name: "media",
        description:
          "音视频处理（基于 ffmpeg）。op 取值：" +
          "probe 探元数据；trim 裁剪（流拷贝，无损但切点对齐关键帧）；convert 转码；" +
          "extract_audio 抽音轨；extract_frame 在指定时间抽一帧；thumbnail 生成缩略图；" +
          "compress 压缩（默认 H.264 CRF 28）。" +
          "setup 用于在缺少 ffmpeg 时自动下载官方静态构建到 .agent/bin。" +
          "时间参数 ss/to/duration 接受秒数或 HH:MM:SS。输入输出均为工作区内相对路径。",
        parameters: {
          type: "object",
          properties: {
            op: {
              type: "string",
              enum: [...OPS],
              description: "要执行的操作",
            },
            input: { type: "string", description: "输入文件路径（工作区内相对路径）" },
            output: { type: "string", description: "输出文件路径（工作区内相对路径）" },
            ss: { type: "string", description: "起始时间，如 12.5 / 00:12.5 / 00:00:12.5" },
            to: { type: "string", description: "结束时间（与 ss 配合，trim 用）" },
            duration: { type: "string", description: "时长（秒，trim 用；与 to 二选一）" },
            format: { type: "string", description: "输出容器格式，如 mp4 / webm / mp3 / png" },
            fps: { type: "number", description: "输出帧率（convert）" },
            width: { type: "number", description: "输出宽度（像素）" },
            height: { type: "number", description: "输出高度（像素）" },
            bitrate: { type: "string", description: "视频码率，如 2M / 1500k" },
            codec: { type: "string", description: "视频编码器，如 libx264 / libvpx-vp9" },
            quality: { type: "number", description: "compress 的 CRF 值 0～51，默认 28" },
            preset: { type: "string", description: "compress 的 x264 preset，默认 medium" },
          },
          required: ["op"],
        },
      },
    },
  );
}
