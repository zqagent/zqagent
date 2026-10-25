/**
 * 内置 OCR 引擎
 *
 * 识别后端按优先级降级（本机引擎优先，多模态模型兜底）：
 *   1. macOS Vision（Swift + PDFKit，免安装，支持 PDF 逐页）
 *   2. tesseract + pdftoppm（Linux/Windows 或非 macOS 环境）
 *   3. 已配置的多模态 LLM（OpenAI 兼容接口，图片走 data URL）
 *   4. 全部不可用 → 返回 error + how_to_fix（不抛异常，模型可读）
 *
 * 所有外部依赖均可通过 OcrRuntimeOverrides 注入，便于单测。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import OpenAI from "openai";
import { findExecutable } from "../../tools/shellRuntime.js";
import type {
  McpBuiltinContext,
  OcrLlmConfig,
  OcrRuntimeOverrides,
} from "./types.js";

/** OCR 输入参数（MCP 工具 recognize 的入参） */
export interface OcrInput {
  /** 本地图片/PDF 路径（相对路径按工作区解析） */
  imagePath?: string;
  /** base64（可带 data URL 前缀） */
  imageBase64?: string;
  /** 远程图片/PDF URL */
  imageUrl?: string;
  /** PDF 最多处理页数（默认 5，上限 50） */
  maxPages?: number;
  /** PDF 渲染 DPI（默认 150，上限 400） */
  dpi?: number;
  /** Tesseract 语言（默认 chi_sim+eng） */
  lang?: string;
}

export type OcrEngineName = "vision" | "tesseract" | "llm";

export interface OcrPage {
  page: number;
  text: string;
}

export type OcrResult =
  | {
      ok: true;
      text: string;
      engine: OcrEngineName;
      pages: OcrPage[];
    }
  | {
      ok: false;
      error: string;
      how_to_fix: string;
      attempts: { engine: string; error: string }[];
    };

const DEFAULT_MAX_PAGES = 5;
const MAX_MAX_PAGES = 50;
const DEFAULT_DPI = 150;
const MAX_DPI = 400;
const CMD_TIMEOUT_MS = 120_000;
const COMPILE_TIMEOUT_MS = 180_000;
const MAX_BUFFER = 32 * 1024 * 1024;

/** Vision 引擎 Swift 源码（首次使用时编译并缓存到 .agent/bin） */
const VISION_SOURCE = `import Foundation
import Vision
import AppKit
import PDFKit
import CoreGraphics

struct PageResult: Codable { let page: Int; let text: String }
struct Output: Codable { let pages: [PageResult] }

func recognize(_ image: CGImage) -> String {
    func run(_ langs: [String]?) throws -> [VNRecognizedTextObservation] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        if let langs = langs { request.recognitionLanguages = langs }
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        try handler.perform([request])
        return request.results ?? []
    }
    let observations = (try? run(["zh-Hans", "zh-Hant", "en-US"])) ?? (try? run(nil)) ?? []
    let lines = observations.compactMap { $0.topCandidates(1).first?.string }
    return lines.joined(separator: "\\n")
}

func imageFromFile(_ p: String) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: p) as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("usage: ocr-vision <file> [maxPages] [dpi]\\n".data(using: .utf8)!)
    exit(2)
}
let file = args[1]
let maxPages = args.count > 2 ? (Int(args[2]) ?? 5) : 5
let dpi = args.count > 3 ? (Int(args[3]) ?? 150) : 150

var pages: [PageResult] = []
if file.lowercased().hasSuffix(".pdf"), let doc = PDFDocument(url: URL(fileURLWithPath: file)) {
    let count = min(doc.pageCount, max(1, maxPages))
    let scale = CGFloat(dpi) / 72.0
    for i in 0..<count {
        guard let page = doc.page(at: i) else { continue }
        let bounds = page.bounds(for: .mediaBox)
        let w = Int(bounds.width * scale)
        let h = Int(bounds.height * scale)
        guard w > 0, h > 0 else { continue }
        guard let ctx = CGContext(
            data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { continue }
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.scaleBy(x: scale, y: scale)
        page.draw(with: .mediaBox, to: ctx)
        guard let image = ctx.makeImage() else { continue }
        pages.append(PageResult(page: i + 1, text: recognize(image)))
    }
} else if let image = imageFromFile(file) {
    pages.append(PageResult(page: 1, text: recognize(image)))
} else {
    FileHandle.standardError.write("unsupported or unreadable image: \\(file)\\n".data(using: .utf8)!)
    exit(3)
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.withoutEscapingSlashes]
if let data = try? encoder.encode(Output(pages: pages)) {
    FileHandle.standardOutput.write(data)
} else {
    exit(4)
}
`;

/** 默认命令执行器 */
function defaultRun(
  command: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: opts.timeoutMs ?? CMD_TIMEOUT_MS,
        cwd: opts.cwd,
        maxBuffer: MAX_BUFFER,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as Error;
          e.message = `${path.basename(command)} 执行失败: ${e.message}${
            stderr ? `\n${stderr.trim()}` : ""
          }`;
          reject(e);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

interface Runtime {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  workspace: string;
  llm?: OcrLlmConfig;
  overrides: OcrRuntimeOverrides;
  which(name: string): string | null;
  run(
    command: string,
    args: string[],
    opts?: { timeoutMs?: number; cwd?: string },
  ): Promise<{ stdout: string; stderr: string }>;
  fileExists(p: string): boolean;
}

function makeRuntime(ctx: McpBuiltinContext): Runtime {
  const overrides = ctx.ocr ?? {};
  const platform = overrides.platform ?? process.platform;
  const env = overrides.env ?? ctx.env ?? process.env;
  const workspace = ctx.workspace ?? env.WORKSPACE ?? process.cwd();
  const fileExists =
    overrides.fileExists ??
    ((p: string): boolean => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
  const which =
    overrides.which ??
    ((name: string): string | null =>
      findExecutable(name, { platform, env, fileExists }));
  return {
    platform,
    env,
    workspace,
    llm: ctx.llm,
    overrides,
    which,
    run: overrides.run ?? defaultRun,
    fileExists,
  };
}

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function isPdfFile(file: string): boolean {
  if (file.toLowerCase().endsWith(".pdf")) return true;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(5);
      const read = fs.readSync(fd, buf, 0, 5, 0);
      return read >= 5 && buf.toString("latin1") === "%PDF-";
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function detectMime(file: string): string {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(12);
      fs.readSync(fd, buf, 0, 12, 0);
      if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
      if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
      if (buf.toString("latin1", 0, 4) === "RIFF") return "image/webp";
      if (buf.toString("latin1", 0, 4) === "GIF8") return "image/gif";
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // 忽略：按扩展名兜底
  }
  const ext = path.extname(file).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function toDataUrl(file: string): string {
  return `data:${detectMime(file)};base64,${fs.readFileSync(file).toString("base64")}`;
}

function dataUrlToBuffer(value: string): { buffer: Buffer; ext: string } {
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(value.trim());
  const mime = m?.[1] ?? "image/png";
  const b64 = m?.[2] ?? value.trim();
  const ext =
    mime === "image/jpeg"
      ? ".jpg"
      : mime === "image/webp"
        ? ".webp"
        : mime === "image/gif"
          ? ".gif"
          : mime === "application/pdf"
            ? ".pdf"
            : ".png";
  return { buffer: Buffer.from(b64, "base64"), ext };
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/** 把图片 URL 下载到临时文件 */
async function downloadToFile(
  url: string,
  dest: string,
  runtime: Runtime,
): Promise<void> {
  const fetchImpl =
    runtime.overrides.fetchImpl ??
    (globalThis.fetch as unknown as OcrRuntimeOverrides["fetchImpl"]);
  if (!fetchImpl) throw new Error("当前运行时不支持 fetch，无法下载 imageUrl");
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`下载图片失败：HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

interface MaterializedInput {
  file: string;
  isPdf: boolean;
  tmpDir: string;
  cleanup(): void;
}

/** 把三种输入形式统一落成临时文件 */
async function materializeInput(
  input: OcrInput,
  runtime: Runtime,
): Promise<MaterializedInput> {
  const root = runtime.overrides.tmpDir ?? os.tmpdir();
  const tmpDir = fs.mkdtempSync(path.join(root, "zqagent-ocr-"));
  const cleanup = (): void => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  };
  try {
    if (typeof input.imagePath === "string" && input.imagePath.trim()) {
      const file = path.isAbsolute(input.imagePath)
        ? input.imagePath
        : path.resolve(runtime.workspace, input.imagePath);
      if (!runtime.fileExists(file) && !fs.existsSync(file))
        throw new Error(`图片不存在：${file}`);
      return { file, isPdf: isPdfFile(file), tmpDir, cleanup };
    }
    if (typeof input.imageBase64 === "string" && input.imageBase64.trim()) {
      const { buffer, ext } = dataUrlToBuffer(input.imageBase64);
      const file = path.join(tmpDir, `input${ext}`);
      fs.writeFileSync(file, buffer);
      return { file, isPdf: isPdfFile(file), tmpDir, cleanup };
    }
    if (typeof input.imageUrl === "string" && input.imageUrl.trim()) {
      const url = input.imageUrl.trim();
      const ext = path.extname(new URL(url).pathname).toLowerCase() || ".png";
      const file = path.join(tmpDir, `input${ext}`);
      await downloadToFile(url, file, runtime);
      return { file, isPdf: isPdfFile(file), tmpDir, cleanup };
    }
    throw new Error("缺少输入：请提供 imagePath / imageBase64 / imageUrl 之一");
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** PDF 转 PNG（依赖 poppler 的 pdftoppm） */
async function pdfToImages(
  file: string,
  tmpDir: string,
  input: OcrInput,
  runtime: Runtime,
): Promise<string[]> {
  const pdftoppm = runtime.which("pdftoppm");
  if (!pdftoppm) {
    throw new Error(
      "PDF 需要 poppler 的 pdftoppm（macOS 可使用内置 Vision 引擎，无需该依赖）",
    );
  }
  const pagesDir = path.join(tmpDir, "pages");
  fs.mkdirSync(pagesDir, { recursive: true });
  const maxPages = clampInt(
    input.maxPages,
    DEFAULT_MAX_PAGES,
    1,
    MAX_MAX_PAGES,
  );
  const dpi = clampInt(input.dpi, DEFAULT_DPI, 36, MAX_DPI);
  await runtime.run(
    pdftoppm,
    [
      "-r",
      String(dpi),
      "-png",
      "-f",
      "1",
      "-l",
      String(maxPages),
      file,
      path.join(pagesDir, "page"),
    ],
    { timeoutMs: CMD_TIMEOUT_MS },
  );
  const images = fs
    .readdirSync(pagesDir)
    .filter((f) => /^page.*\.png$/i.test(f))
    .sort(naturalCompare)
    .map((f) => path.join(pagesDir, f));
  if (images.length === 0) throw new Error("PDF 转图片失败（未生成页面）");
  return images;
}

interface VisionBuild {
  binary: string | null;
  error?: string;
}

// Vision 编译任务按 workspace 缓存：并发 OCR 只编译一次，
// 失败结果同样缓存，避免长驻进程内每次 OCR 都重复等待编译。
const visionBuilds = new Map<string, Promise<VisionBuild>>();

/** 从编译器输出中提取一行可读错误（避免把整页 modulemap 灌给模型） */
function conciseError(err: Error): string {
  const lines = err.message
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /error:|fatal error:/i.test(l));
  const pick = lines.length > 0 ? lines[lines.length - 1]! : err.message;
  return pick.slice(0, 500);
}

/** 确保 Vision 二进制已编译；不可用时返回原因 */
async function ensureVisionBinary(runtime: Runtime): Promise<VisionBuild> {
  if (runtime.platform !== "darwin")
    return { binary: null, error: "仅 macOS 可用" };
  const swiftc = runtime.which("swiftc");
  if (!swiftc)
    return {
      binary: null,
      error: "未找到 swiftc（需要 Xcode Command Line Tools）",
    };

  const dir = path.join(runtime.workspace, ".agent", "bin");
  const srcPath = path.join(dir, "ocr-vision.swift");
  const binPath = path.join(dir, "ocr-vision");
  const cacheKey = binPath;
  const cached = visionBuilds.get(cacheKey);
  if (cached) return cached;

  const build = (async (): Promise<VisionBuild> => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      let changed = true;
      try {
        changed = fs.readFileSync(srcPath, "utf8") !== VISION_SOURCE;
      } catch {
        changed = true;
      }
      if (changed) fs.writeFileSync(srcPath, VISION_SOURCE, "utf8");
      if (changed || !runtime.fileExists(binPath)) {
        await runtime.run(swiftc, ["-O", "-o", binPath, srcPath], {
          timeoutMs: COMPILE_TIMEOUT_MS,
        });
      }
      return runtime.fileExists(binPath)
        ? { binary: binPath }
        : { binary: null, error: "Vision 编译未生成可执行文件" };
    } catch (err) {
      // 编译失败（如 CLT 与 SDK 版本不匹配）：降级到其它引擎
      return { binary: null, error: `Vision 编译失败: ${conciseError(err as Error)}` };
    }
  })();
  visionBuilds.set(cacheKey, build);
  return build;
}

async function runVision(
  binary: string,
  file: string,
  input: OcrInput,
  runtime: Runtime,
): Promise<OcrPage[]> {
  const maxPages = clampInt(
    input.maxPages,
    DEFAULT_MAX_PAGES,
    1,
    MAX_MAX_PAGES,
  );
  const dpi = clampInt(input.dpi, DEFAULT_DPI, 36, MAX_DPI);
  const { stdout } = await runtime.run(
    binary,
    [file, String(maxPages), String(dpi)],
    { timeoutMs: CMD_TIMEOUT_MS },
  );
  const parsed = JSON.parse(stdout) as { pages?: OcrPage[] };
  const pages = Array.isArray(parsed.pages) ? parsed.pages : [];
  if (pages.length === 0) throw new Error("Vision 未返回识别结果");
  return pages.map((p) => ({
    page: Number(p.page) || 1,
    text: typeof p.text === "string" ? p.text : "",
  }));
}

async function runTesseract(
  file: string,
  isPdf: boolean,
  input: OcrInput,
  runtime: Runtime,
  tmpDir: string,
): Promise<OcrPage[]> {
  const tesseract = runtime.which("tesseract");
  if (!tesseract) throw new Error("未找到 tesseract");
  const lang = input.lang ?? runtime.env.OCR_LANG ?? "chi_sim+eng";
  const images = isPdf
    ? await pdfToImages(file, tmpDir, input, runtime)
    : [file];
  const pages: OcrPage[] = [];
  for (let i = 0; i < images.length; i += 1) {
    const { stdout } = await runtime.run(
      tesseract,
      [images[i]!, "stdout", "-l", lang, "--psm", "3"],
      { timeoutMs: CMD_TIMEOUT_MS },
    );
    pages.push({ page: i + 1, text: stdout.trim() });
  }
  return pages;
}

function resolveLlmConfig(runtime: Runtime): {
  apiKey: string;
  model: string;
  baseURL?: string;
} | null {
  const llm = runtime.llm;
  const apiKey =
    llm?.apiKey ??
    runtime.env.OPENAI_API_KEY ??
    runtime.env.OCR_API_KEY ??
    "";
  const model =
    llm?.model ?? runtime.env.OCR_MODEL ?? runtime.env.OPENAI_MODEL ?? "";
  const baseURL =
    llm?.baseURL ?? runtime.env.OPENAI_BASE_URL ?? runtime.env.OCR_BASE_URL;
  if (!apiKey || !model) return null;
  return { apiKey, model, baseURL };
}

async function defaultLlmComplete(req: {
  model: string;
  prompt: string;
  imageDataUrl: string;
  baseURL?: string;
  apiKey?: string;
}): Promise<string> {
  const client = new OpenAI({
    apiKey: req.apiKey ?? "",
    ...(req.baseURL ? { baseURL: req.baseURL } : {}),
  });
  const res = await client.chat.completions.create({
    model: req.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: req.prompt },
          { type: "image_url", image_url: { url: req.imageDataUrl } },
        ],
      },
    ],
  });
  return res.choices?.[0]?.message?.content ?? "";
}

async function runLlm(
  file: string,
  isPdf: boolean,
  input: OcrInput,
  runtime: Runtime,
  tmpDir: string,
): Promise<OcrPage[]> {
  const cfg = resolveLlmConfig(runtime);
  if (!cfg) {
    throw new Error("未配置多模态模型（缺少 API key 或 model）");
  }
  const images = isPdf
    ? await pdfToImages(file, tmpDir, input, runtime)
    : [file];
  const prompt =
    "请逐字提取这张图片中的全部文字，保持原有换行与顺序。只输出文字，不要解释。";
  const complete = runtime.overrides.llmComplete ?? defaultLlmComplete;
  const pages: OcrPage[] = [];
  for (let i = 0; i < images.length; i += 1) {
    const text = await complete({
      model: cfg.model,
      prompt,
      imageDataUrl: toDataUrl(images[i]!),
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
    });
    pages.push({ page: i + 1, text: text.trim() });
  }
  return pages;
}

function joinPages(pages: OcrPage[]): string {
  if (pages.length === 1) return pages[0]!.text;
  return pages
    .map((p) => `--- page ${p.page} ---\n${p.text}`)
    .join("\n\n");
}

function howToFix(platform: NodeJS.Platform): string {
  if (platform === "darwin")
    return [
      "macOS 可任选其一：",
      "1) 安装 Xcode Command Line Tools 以启用内置 Vision：xcode-select --install",
      "2) 安装 tesseract 与 poppler：brew install tesseract tesseract-lang poppler",
      "3) 用 /connect 配置支持图片输入的多模态模型后重试",
    ].join("\n");
  if (platform === "win32")
    return [
      "Windows 可任选其一：",
      "1) 安装 tesseract：winget install UB-Mannheim.TesseractOCR",
      "2) 安装 poppler（PDF 需要）并加入 PATH",
      "3) 用 /connect 配置支持图片输入的多模态模型后重试",
    ].join("\n");
  return [
    "Linux 可任选其一：",
    "1) apt-get install -y tesseract-ocr tesseract-ocr-chi-sim poppler-utils",
    "2) 用 /connect 配置支持图片输入的多模态模型后重试",
  ].join("\n");
}

/** 引擎探测顺序（OCR_ENGINE 可强制指定） */
function engineOrder(runtime: Runtime): OcrEngineName[] {
  const forced = (runtime.env.OCR_ENGINE ?? "").toLowerCase();
  if (forced === "vision" || forced === "tesseract" || forced === "llm")
    return [forced];
  return ["vision", "tesseract", "llm"];
}

/**
 * 识别图片或 PDF。
 * 不抛异常：失败时返回 { ok:false, error, how_to_fix, attempts }。
 */
export async function recognizeOcr(
  input: OcrInput,
  ctx: McpBuiltinContext = {},
): Promise<OcrResult> {
  const runtime = makeRuntime(ctx);
  let materialized: MaterializedInput;
  try {
    materialized = await materializeInput(input, runtime);
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      how_to_fix: howToFix(runtime.platform),
      attempts: [],
    };
  }

  const attempts: { engine: string; error: string }[] = [];
  try {
    for (const engine of engineOrder(runtime)) {
      try {
        let pages: OcrPage[];
        if (engine === "vision") {
          const build = await ensureVisionBinary(runtime);
          if (!build.binary) {
            attempts.push({ engine, error: build.error ?? "不可用" });
            continue;
          }
          pages = await runVision(
            build.binary,
            materialized.file,
            input,
            runtime,
          );
        } else if (engine === "tesseract") {
          pages = await runTesseract(
            materialized.file,
            materialized.isPdf,
            input,
            runtime,
            materialized.tmpDir,
          );
        } else {
          pages = await runLlm(
            materialized.file,
            materialized.isPdf,
            input,
            runtime,
            materialized.tmpDir,
          );
        }
        if (pages.length === 0) throw new Error("未识别到任何页面");
        return {
          ok: true,
          text: joinPages(pages),
          engine,
          pages,
        };
      } catch (err) {
        attempts.push({ engine, error: (err as Error).message });
      }
    }
    return {
      ok: false,
      error:
        attempts.length > 0
          ? `没有可用的 OCR 引擎: ${attempts
              .map((a) => `${a.engine}: ${a.error}`)
              .join("; ")}`
          : "没有可用的 OCR 引擎",
      how_to_fix: howToFix(runtime.platform),
      attempts,
    };
  } finally {
    materialized.cleanup();
  }
}
