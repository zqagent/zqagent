/**
 * zqagent CLI — 交互式命令行入口
 *
 * 本文件是 CLI 入口：负责加载环境变量、装配默认引擎（通过 createDefaultEngine）、
 * 实现命令行审批器，以及驱动事件循环渲染输出。
 *
 * 启动方式：`tsx src/cli/index.ts`（开发）或 `zqagent`（安装后）
 */

// 必须排在所有依赖之前：静音 Node 内置 punycode 的 DEP0040 警告（细节见该文件）
import "./quietDeprecations.js";
import "dotenv/config";
import * as fs from "fs";
import * as readline from "readline";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import {
  createDefaultEngine,
  TurnEngine,
  EventType,
  ApprovalOutcome,
  Mode,
  ConsoleHook,
  SubagentHook,
  CompositeHook,
  FileLogHook,
  AgentRegistry,
  BUILTIN_AGENTS,
  McpManager,
  OpenAIProvider,
  MarkdownRenderer,
  approvalToMarkdownTable,
  setQuestionHandler,
  parsePicks,
  setPlanHandler,
  setDirectoryHandler,
  loadPermissionConfig,
  resolveSandbox,
  describeSandbox,
  resolveVcsPlan,
  SessionVcs,
  VcsHook,
} from "../index.js";
import type {
  WsEvent,
  PermissionRequest,
  SavedState,
  AgentDef,
  McpServerConfig,
  ToolRegistry,
  ReasoningEffort,
  Message,
  ProviderClient,
  StreamChunk,
} from "../index.js";
import {
  normalizeMcpConfigs,
  readMcpConfigFile,
  saveMcpConfigFile,
  splitCommandLine,
  withBuiltinMcpConfigs,
} from "../mcp/config.js";
import {
  applyMcpPreset,
  MCP_PRESETS,
  type McpPreset,
} from "../mcp/presets.js";
import {
  loadConnection,
  loadConnectionById,
  saveConnection,
  clearConnection,
  listConnections,
  useConnection,
  removeConnection,
  fetchModelsWithDiagnostics,
  describeModelFetchFailure,
  fetchModelContext,
  probeModel,
  modelContextWindow,
  saveProviderModelMeta,
  PROVIDERS,
} from "./connection.js";
import type { ConnectionConfig } from "./connection.js";
import { BUILTIN_PROVIDER_ID } from "../server/llmIds.js";
import { InputRouter, countRawEscapes, patchReadlineHistoryNav } from "./input.js";
import { createRequire } from "module";
import { renderBanner } from "./banner.js";
import {
  buildTerminalInstallPrompt,
  detectTerminalSetup,
  hasWindowsTerminal,
  renderTerminalTutorial,
} from "./terminalSetup.js";
import { cliErr, cliLog, cliWrite, UNICODE_SUPPORTED } from "../terminal.js";
import { authErrorHints, paramErrorHints } from "../providers/diagnostics.js";
import { stateDir } from "../paths.js";
import { runLinkCommand } from "./link.js";
import { runRenameCommand } from "./rename.js";
import { runServeCommand } from "./serve.js";
import { runUpdateCommand } from "./update.js";
import {
  shouldAutoName,
  sanitizeSessionName,
  updateSessionMetaFile,
} from "./sessionMeta.js";
import type { SessionMeta } from "./sessionMeta.js";
import {
  enableDebug,
  logEnvironment,
  dlog,
  describeError,
  debugStage,
  debugStageAsync,
} from "./debug.js";
import {
  DEFAULT_MAX_ITERATIONS,
  parseMaxIterations,
  parseOptionalPositiveNumber,
  parseRatio,
} from "../engine/limits.js";

const execAsync = promisify(exec);

// ===================== 启动诊断 =====================

// `--debug` 或 `ZQAGENT_DEBUG=1` 时开启（实现见 debug.ts）。必须尽早调用：之后
// 任何初始化抛错都会被同步落盘，而不是「一闪而过、无输出」。SEA 单文件产物在
// bundle 顶部已有启动引导（tsup.sea.config.ts 注入），此处复用同一份日志文件。
if (enableDebug(process.argv)) {
  logEnvironment();
}

// ===================== 配置 =====================

/**
 * 环境变量里指定的模型（`OPENAI_MODEL`）。
 *
 * 不再兜底成 `gpt-4o`：没配就保持空，启动横幅显示「未选择」，第一次发消息时
 * 提示去 `/connect` 选模型，而不是拿一个用户根本没有 Key 的型号去请求。
 */
const MODEL = process.env.OPENAI_MODEL ?? "";
/** 工作区根目录（环境变量 WORKSPACE，默认当前目录） */
const WORKSPACE = path.resolve(process.env.WORKSPACE ?? ".");
/** 单轮最大迭代次数（环境变量 MAX_ITERATIONS 可覆盖，缺省 DEFAULT_MAX_ITERATIONS） */
const MAX_ITERATIONS = parseMaxIterations(
  process.env.MAX_ITERATIONS,
  DEFAULT_MAX_ITERATIONS,
);
/** 持久化目录（跨平台：见 paths.ts） */
const STATE_DIR = stateDir();

/**
 * 列出所有已保存的会话（`{sessionId}_state.json`），按最后保存时间降序。
 * 损坏或结构非法的 state 文件静默跳过。
 */
function listSessions(): SavedState[] {
  try {
    const files = fs.readdirSync(STATE_DIR);
    const sessions: SavedState[] = [];
    for (const f of files) {
      if (!f.endsWith("_state.json")) continue;
      try {
        const parsed = JSON.parse(
          fs.readFileSync(path.join(STATE_DIR, f), "utf8"),
        ) as SavedState;
        if (parsed && typeof parsed.sessionId === "string") {
          sessions.push(parsed);
        }
      } catch {
        // 跳过损坏的 state 文件
      }
    }
    sessions.sort((a, b) => (b.savedAt ?? "").localeCompare(a.savedAt ?? ""));
    return sessions;
  } catch {
    return [];
  }
}

/**
 * 保存引擎当前状态到 FileLogHook（若已挂载），并合并当前会话的
 * 命名元数据（name / nameSource / taskCount）。退出（quit/Ctrl+C）、
 * 任务完成、/sessions 等场景共用，用于 Durable Resume。
 */
function saveEngineState(engine: TurnEngine): void {
  const fileHook = (engine as unknown as Record<string, unknown>)[
    "_fileHook"
  ] as FileLogHook | undefined;
  fileHook?.saveState(engine, {
    name: sessionMeta.name,
    nameSource: sessionMeta.nameSource,
    taskCount: sessionMeta.taskCount,
  });
}

/**
 * 渲染并打印最后一轮 AI 助手（agent）消息的完整内容（Markdown 渲染）。
 * 用于会话恢复时回显会话最后内容，便于用户理解上下文。
 */
function printLastAssistantMessage(messages: Message[]): void {
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && (m.content ?? "").trim() !== "");
  if (!lastAssistant) {
    cliLog("📄 最后一轮 AI 回复: （无）");
    return;
  }
  cliLog("📄 最后一轮 AI 回复:");
  const renderer = new MarkdownRenderer({ unicode: UNICODE_SUPPORTED });
  let out = renderer.push(lastAssistant.content + "\n");
  out += renderer.flush();
  cliWrite(out + "\n");
}

/** Agent 定义持久化文件（项目内 .agent/agents.json，随项目走，可提交 git） */
const AGENTS_FILE = path.join(WORKSPACE, ".agent", "agents.json");

// ===================== Agent 注册表与持久化 =====================

/**
 * 从 AGENTS_FILE 加载自定义 agent 定义。
 * 文件不存在 / 解析失败 / 结构非法时静默返回空数组。
 */
function loadAgentsFromFile(): AgentDef[] {
  try {
    if (!fs.existsSync(AGENTS_FILE)) return [];
    const raw = fs.readFileSync(AGENTS_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (d): d is AgentDef =>
        !!d &&
        typeof d === "object" &&
        typeof (d as AgentDef).name === "string" &&
        typeof (d as AgentDef).prompt === "string",
    );
  } catch {
    return [];
  }
}

/** 把当前全部 agent 定义写入 AGENTS_FILE（完整快照，含内置） */
function saveAgentsToFile(defs: AgentDef[]): void {
  try {
    fs.mkdirSync(path.dirname(AGENTS_FILE), { recursive: true });
    fs.writeFileSync(AGENTS_FILE, JSON.stringify(defs, null, 2) + "\n", "utf8");
  } catch (err) {
    cliErr(`⚠️  保存 agents 配置失败: ${err}`);
  }
}

/**
 * Agent 注册表（内存管理；持久化由本文件的 load/save 负责）。
 * 加载顺序：内置 code/cowork 优先，磁盘 agents.json 后写覆盖同名、追加新增。
 */
const agentRegistry = new AgentRegistry([
  ...BUILTIN_AGENTS,
  ...loadAgentsFromFile(),
]);

// ===================== MCP 与工具管理 =====================

/** MCP 服务器配置持久化文件 */
const MCP_FILE = path.join(WORKSPACE, ".agent", "mcp.json");
/** 命令工具（/tool add 创建）持久化文件 */
const COMMAND_TOOLS_FILE = path.join(WORKSPACE, ".agent", "tools.json");

/** 命令工具定义 */
interface CommandToolDef {
  name: string;
  command: string;
}

/** 通用 JSON 数组读取（文件不存在 / 解析失败 / 非数组时返回空数组） */
function loadJsonArray<T>(
  file: string,
  validate?: (v: unknown) => boolean,
): T[] {
  try {
    if (!fs.existsSync(file)) return [];
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    if (!validate) return parsed as T[];
    return parsed.filter((v): v is T => validate(v));
  } catch {
    return [];
  }
}

/** 通用 JSON 写入（自动创建目录，格式化缩进） */
function saveJsonFile(file: string, data: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch (err) {
    cliErr(`⚠️  保存配置失败: ${err}`);
  }
}

/**
 * 从 MCP_FILE 加载 MCP 服务器配置。
 * 兼容裸数组 / {servers} / {mcpServers}（Claude/Cursor）等格式，
 * 并追加内置默认服务器（如 OCR）。
 */
function loadMcpConfigs(): McpServerConfig[] {
  const { configs, warnings } = readMcpConfigFile(MCP_FILE);
  for (const w of warnings) cliErr(`⚠️  MCP 配置: ${w}`);
  return withBuiltinMcpConfigs(configs);
}

/** 保存 MCP 服务器配置（完整快照） */
function saveMcpConfigs(): void {
  // manager 尚未创建时回退到当前加载的配置，避免把已有文件清空
  const configs = mcpManager?.listConfigs() ?? loadMcpConfigs();
  try {
    saveMcpConfigFile(MCP_FILE, configs);
  } catch (err) {
    cliErr(`⚠️  保存 MCP 配置失败: ${err}`);
  }
}

/** 从 COMMAND_TOOLS_FILE 加载命令工具定义 */
function loadCommandTools(): CommandToolDef[] {
  return loadJsonArray<CommandToolDef>(
    COMMAND_TOOLS_FILE,
    (v) =>
      !!v &&
      typeof v === "object" &&
      typeof (v as CommandToolDef).name === "string" &&
      typeof (v as CommandToolDef).command === "string",
  );
}

/** 保存命令工具定义 */
function saveCommandTools(defs: CommandToolDef[]): void {
  saveJsonFile(COMMAND_TOOLS_FILE, defs);
}

/**
 * 把命令工具注册到 ToolRegistry。
 * 调用时在 WORKSPACE 下执行固定 shell 命令，"arguments" 参数追加到命令末尾。
 */
function registerCommandTools(
  registry: ToolRegistry,
  defs: CommandToolDef[],
): void {
  for (const def of defs) {
    registry.register(
      async (args) => {
        const extra = String(args.arguments ?? args.args ?? "").trim();
        const cmd = extra ? `${def.command} ${extra}` : def.command;
        try {
          const { stdout, stderr } = await execAsync(cmd, {
            cwd: WORKSPACE,
            timeout: 120_000,
            maxBuffer: 16 * 1024 * 1024,
          });
          const parts = [
            stdout,
            stderr && stderr.trim() ? `[stderr]\n${stderr}` : "",
          ].filter(Boolean);
          return parts.join("\n").trim() || "(无输出)";
        } catch (err) {
          return { error: String(err) };
        }
      },
      {
        category: "cli",
        riskLevel: "high",
        capabilities: [`命令工具: ${def.command}`],
        requiresApproval: true,
      },
      {
        type: "function",
        function: {
          name: def.name,
          description: `执行 shell 命令：${def.command}（"arguments" 参数会追加到命令末尾）`,
          parameters: {
            type: "object",
            properties: {
              arguments: {
                type: "string",
                description: "追加到命令后的参数（可选）",
              },
            },
          },
        },
      },
      "cli:command",
    );
  }
}

/** MCP 管理器（内存管理；持久化由本文件 load/save 负责） */
let mcpManager: McpManager | null = null;

// 解析命令行参数
function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--resume" || argv[i] === "--r") {
      result["resume"] = argv[++i] ?? "";
    }
  }
  return result;
}

// 生成简短会话 ID
function randomHex(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(
    { length: len },
    () => chars[Math.floor(Math.random() * chars.length)],
  ).join("");
}

/** 判断会话是否为空（用户未下发任何指令，即无 user 消息） */
function isEmptySession(s: SavedState): boolean {
  return !(s.messages ?? []).some((m) => m.role === "user");
}

/**
 * 启动时决定会话 ID：
 * - 指定 --resume → 用指定 ID；
 * - 已存在空会话 → 复用它（避免每次启动都新建空会话）；
 * - 否则生成新的随机 ID。
 */
function resolveInitialSessionId(resumeId?: string): string {
  if (resumeId) return resumeId;
  const empty = listSessions().find(isEmptySession);
  return empty?.sessionId ?? randomHex(12);
}

/**
 * 清理多余的空会话（state + jsonl 文件），只保留指定 ID 的那个，
 * 确保系统里永远最多只有一个空会话。
 */
function pruneEmptySessions(keepSessionId: string): void {
  for (const s of listSessions()) {
    if (!isEmptySession(s) || s.sessionId === keepSessionId) continue;
    for (const suffix of ["_state.json", ".jsonl"]) {
      try {
        fs.unlinkSync(path.join(STATE_DIR, `${s.sessionId}${suffix}`));
      } catch {
        /* 忽略删除失败 */
      }
    }
  }
}

// 命令行参数
const cliArgs = parseArgs(process.argv.slice(2));
const resumeId = cliArgs["resume"];
// 当前会话 ID（let：运行时可通过 /sessions 恢复到其它会话）
let SESSION_ID = resolveInitialSessionId(resumeId);
// 启动即清理多余的空会话，保证永远只保留一个空会话
if (!resumeId) pruneEmptySessions(SESSION_ID);

/**
 * 当前会话的命名元数据（内存态）。
 * main() 启动/切换会话时从 state 文件重建；随 saveEngineState 持久化。
 */
let sessionMeta: SessionMeta = { sessionId: SESSION_ID, taskCount: 0 };
/** 是否有正在进行的会话命名请求（防重入） */
let namingInFlight = false;

// 权限配置：项目级 `.agent/permissions.json`，缺省时用内置默认值
// （命令白名单 / shell 免审策略 / 启动模式 / 沙箱配置）
const PERM_CONFIG = loadPermissionConfig(WORKSPACE);
const ALLOWED_COMMANDS = PERM_CONFIG.allowedCommands;
// 沙箱方案只解析一次：探测结果有缓存，引擎重建时复用同一份
const SANDBOX_PLAN = resolveSandbox({
  mode: PERM_CONFIG.sandbox.mode,
  extraWritable: PERM_CONFIG.sandbox.extraWritable,
  workspace: WORKSPACE,
});

/**
 * 当前会话的变更追踪（引擎重建时随 buildEngine 一起替换）。
 * 模块级是因为命令处理器（/changes、/restore）需要访问，
 * 而它们不在 buildEngine 的作用域内。
 */
let sessionVcs: SessionVcs | null = null;
let vcsHook: VcsHook | null = null;

// ===================== 模式切换 (Tab) =====================

/**
 * Tab 键循环切换的模式顺序：询问(交互) → 计划 → 自动 → 询问。
 * 当前模式不在序列中（如 discuss）时，下一次回到序列首个。
 */
const MODE_CYCLE: Mode[] = [Mode.INTERACTIVE, Mode.PLAN, Mode.AUTO];

/** 模式的中文说明（与 /plan /interactive /auto 的提示文案保持一致） */
const MODE_LABEL: Record<Mode, string> = {
  [Mode.DISCUSS]: "只读对话",
  [Mode.PLAN]: "只读探索 + 计划提案",
  [Mode.INTERACTIVE]: "逐步审批",
  [Mode.AUTO]: "全自动，无需审批",
};

/** 主循环提示符（模式/agent 变化后据此原地重绘） */
function mainPrompt(engine: TurnEngine): string {
  return `\n[${engine.permissions.mode}][${agentRegistry.current}] > `;
}

/** 按 MODE_CYCLE 顺序推进到下一个模式 */
function cycleMode(engine: TurnEngine): Mode {
  const idx = MODE_CYCLE.indexOf(engine.permissions.mode);
  const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length]!;
  engine.permissions.mode = next;
  return next;
}

// ===================== 审批器 =====================

/** readline 实例（CLI 输入） */
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

/**
 * 统一输入路由：所有行输入（审批/提问/主循环命令/运行中补充信息）
 * 都经此分发。运行中输入的文字会作为 steering 注入当前任务。
 */
const inputRouter = new InputRouter({
  rl,
  stdout: process.stdout,
  onSteered: (text) => {
    cliLog(`\n⤴ 已记录补充信息，将在下一迭代生效: ${text}`);
  },
});

/** 退出处理器引用（由 main() 赋值，供 readline SIGINT 回调使用） */
let _exitHandler: (() => void) | null = null;

// readline 在等待输入时消费 SIGINT 信号（不会触发 process.on("SIGINT")）
rl.on("SIGINT", () => {
  _exitHandler?.();
});

/**
 * 修复 readline 的历史导航（前缀搜索 / 草稿保留），实现见 input.ts。
 * 必须在 InputRouter 构造之后调用，保持 历史导航 → 粘贴守卫 → 原生 的调用链。
 */
patchReadlineHistoryNav(rl);

// 模块初始化收尾标记：这行出现在日志里，就说明顶层代码（含全部依赖的初始化）
// 都已通过，之后的问题一律在 main() 内——两者的排查方向完全不同。
dlog("init", "模块初始化完成（readline / 输入路由 / 历史导航就绪）");

/** 向用户提问并等待一行回答 */
function question(prompt: string): Promise<string> {
  return inputRouter.ask(prompt);
}

/**
 * 隐藏输入（API key 等敏感信息，不回显，输入以 * 占位）。
 * 非 TTY 环境（管道/脚本）下降级为普通 question。
 */
function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return question(prompt);
  return new Promise((resolve) => {
    // 独占 stdin：readline 挂在 stdin 上的 data 监听（keypress 解码）在我们读取
    // 期间会继续回显明文——光靠 rl.pause() 拦不住它（实测每个字符会「明文 + *」
    // 各输出一次），必须先摘掉、读完再原样恢复。
    const savedDataListeners = process.stdin.listeners("data");
    process.stdin.removeAllListeners("data");
    cliWrite(prompt);
    inputRouter.suspend(); // 密码期间忽略行路由
    rl.pause();
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let buf = "";
    const onData = (chunk: Buffer) => {
      // 剥离 ANSI 转义序列（方向键等），保留可打印字符
      const s = chunk
        .toString()
        .replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, "")
        .replace(/\x1bO[A-Za-z]/g, "");
      for (let i = 0; i < s.length; i++) {
        const ch = s[i]!;
        if (ch === "\r" || ch === "\n") {
          cleanup();
          cliWrite("\n");
          resolve(buf);
          return;
        }
        if (ch === "\x03") {
          // Ctrl+C
          cleanup();
          cliWrite("\n");
          resolve("");
          return;
        }
        if (ch === "\x7f" || ch === "\b") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            cliWrite("\b \b");
          }
        } else if (ch >= " ") {
          buf += ch;
          cliWrite("*");
        }
      }
    };
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      // 恢复 readline 的 data 监听，让行输入能力（历史/编辑/提交）回来
      for (const listener of savedDataListeners) {
        process.stdin.on("data", listener as (chunk: Buffer) => void);
      }
      // readline 在终端模式下始终需要 raw mode（否则方向键等
      // 转义序列会被终端行缓冲吞掉，导致上下键历史失效），
      // 因此这里必须恢复为 true 而不是关闭。
      process.stdin.setRawMode(true);
      rl.resume();
      inputRouter.resume(); // 恢复行路由
    };
    process.stdin.on("data", onData);
  });
}

/**
 * 当前 LLM 连接配置（内存缓存）。
 * 启动时从磁盘加载一次；/connect 保存后更新；引擎重建时据此创建 provider。
 */
let currentConnection: ConnectionConfig | null = null;

/**
 * CLI 审批器
 *
 * 展示「审批表格」（工具、原因、参数详情，与其他通道统一格式），
 * 交互式询问用户：Y=允许一次 / A=总是允许此工具 / D=拒绝；
 * 仅 run_shell 额外提供 C=总是允许此命令（按具体命令白名单）。
 */
async function cliApprover(
  request: PermissionRequest,
): Promise<ApprovalOutcome> {
  const toolName = request.toolName;
  const reason = request.reason;
  const args = request.arguments;

  // 显示审批表格（工具 / 原因 / 参数详情，与其他通道同一套字段）
  const table = approvalToMarkdownTable(
    { toolName, reason, arguments: args },
    { title: "🔒 需要审批" },
  );
  const renderer = new MarkdownRenderer({ unicode: UNICODE_SUPPORTED });
  const rendered = renderer.push(table + "\n\n") + renderer.flush();
  if (rendered.trim()) cliLog("\n" + rendered.trimEnd());

  // 循环直到输入合法选项（shell 额外提供「总是允许此命令」细粒度白名单）
  const isShell = toolName === "run_shell";
  const prompt = isShell
    ? "  [Y] 允许一次  [A] 总是允许此工具  [C] 总是允许此命令  [D] 拒绝: "
    : "  [Y] 允许一次  [A] 总是允许此工具  [D] 拒绝: ";
  const help = isShell
    ? "  请输入 Y (允许一次) / A (总是允许此工具) / C (总是允许此命令) / D (拒绝)"
    : "  请输入 Y (允许一次) / A (总是允许此工具) / D (拒绝)";
  while (true) {
    const answer = await question(prompt);
    const lower = answer.trim().toLowerCase();
    if (lower === "y" || lower === "yes") return ApprovalOutcome.ONCE;
    if (lower === "a" || lower === "always") return ApprovalOutcome.ALWAYS_TOOL;
    if (isShell && (lower === "c" || lower === "cmd" || lower === "command"))
      return ApprovalOutcome.ALWAYS_COMMAND;
    if (lower === "d" || lower === "n" || lower === "no")
      return ApprovalOutcome.DENY;
    cliLog(help);
  }
}

// ===================== 引擎构建 =====================

/**
 * 未配置 LLM 连接时的占位 Provider：实现 ProviderClient 接口，被调用时
 * 抛出友好提示，引导用户先运行 /connect。避免 CLI 在「无任何配置」时
 * 因 OpenAIProvider 构造函数抛错而无法启动。
 *
 * `message` 供「有 Key 但没选模型」这类半配置状态复用，提示要具体。
 */
function createUnconfiguredProvider(
  message = "❌ 尚未配置 LLM 连接，请先运行 /connect",
): ProviderClient {
  return {
    async stream(): Promise<AsyncIterable<StreamChunk>> {
      throw new Error(message);
    },
    async chat(): Promise<string | null> {
      throw new Error(message);
    },
  };
}

/**
 * 装配完整的 TurnEngine（带 CLI 钩子）
 *
 * 使用 createDefaultEngine 一键装配核心组件，然后注入
 * ConsoleHook + FileLogHook 组合钩子与 CLI 审批器。
 */
/** 从会话快照里取权限模式；缺失或非法时返回 null */
function restoredMode(state?: SavedState | null): Mode | null {
  const m = state?.permissionMode;
  return m === Mode.DISCUSS ||
    m === Mode.PLAN ||
    m === Mode.INTERACTIVE ||
    m === Mode.AUTO
    ? m
    : null;
}

function buildEngine(
  sessionId: string,
  savedState?: SavedState | null,
): TurnEngine {
  const fileHook = new FileLogHook(sessionId, STATE_DIR);
  // explore 的结果卡片只留一行摘要：完整报告已由 SubagentHook 渲染在子代理进度块里
  const consoleHook = new ConsoleHook({ compactResultTools: ["explore"] });
  // 变更追踪：每轮结束记一个快照，便于事后审计与回滚
  sessionVcs = new SessionVcs(
    resolveVcsPlan(WORKSPACE, { mode: PERM_CONFIG.vcs.mode }),
    sessionId,
  );
  vcsHook = new VcsHook(sessionVcs);
  const hook = new CompositeHook([consoleHook, fileHook, vcsHook]);

  // Provider 装配优先级：
  //   1. /connect 配置存在 → 用配置的 key/baseURL 创建；
  //   2. 有 OPENAI_API_KEY 环境变量 → 不传 provider（createDefaultEngine 内部用环境变量创建）；
  //   3. 全无配置（或只有 Key 没选模型）→ 用占位 Provider
  //      （避免启动崩溃，第一次发消息时提示具体该补什么）。
  const conn = currentConnection;
  const hasEnvKey = !!process.env.OPENAI_API_KEY;
  // 当前生效模型：会话状态覆盖配置，最后落到环境变量；都没有就是空（未选择）
  const model = savedState?.model ?? conn?.model ?? MODEL;
  const provider = conn
    ? new OpenAIProvider({
        apiKey: conn.apiKey,
        baseURL: conn.baseURL,
        logDir: ".logs/llm",
      })
    : hasEnvKey && model
      ? undefined
      : createUnconfiguredProvider(
          hasEnvKey
            ? "❌ 尚未选择模型，请运行 /connect 选择，或设置 OPENAI_MODEL 环境变量"
            : undefined,
        );
  const engine = createDefaultEngine({
    workspace: WORKSPACE,
    model,
    provider,
    reasoningEffort: conn?.reasoningEffort ?? undefined,
    // 恢复会话时沿用上次的模式（SavedState 持久化），否则用配置里的默认模式
    mode: restoredMode(savedState) ?? PERM_CONFIG.mode,
    maxIterations: MAX_ITERATIONS,
    allowedCommands: ALLOWED_COMMANDS,
    shellPolicy: PERM_CONFIG.shellPolicy,
    sandbox: {
      mode: PERM_CONFIG.sandbox.mode,
      extraWritable: PERM_CONFIG.sandbox.extraWritable,
    },
    hook,
    // explore 子代理的执行过程缩进打印（工厂：并发 explore 各自独立渲染）
    subagentHookFactory: () => new SubagentHook(),
    messages: savedState?.messages,
    logDir: ".logs/llm",
    // 上下文窗口直接决定压缩触发点：环境变量 > 供应商 /models 返回的真实值 >
    // 引擎内置表（lookupContextWindow 兜底，见 TurnEngine._contextWindow）
    contextWindow:
      parseOptionalPositiveNumber(process.env.CONTEXT_WINDOW) ??
      modelContextWindow(conn?.modelMeta, model),
    thresholdPct: parseRatio(process.env.COMPACTION_THRESHOLD_PCT),
    softThresholdPct: parseRatio(process.env.COMPACTION_SOFT_THRESHOLD_PCT),
    capTokens:
      parseOptionalPositiveNumber(process.env.COMPACTION_CAP_TOKENS) ?? null,
    // 系统提示词按当前 agent 组装（agent prompt + 叙述规则 + 环境信息）
    instructions: agentRegistry.buildSystemPrompt(
      agentRegistry.current,
      WORKSPACE,
      new Date().toISOString().split("T")[0]!,
    ),
  });

  engine.setApprover(cliApprover);

  // 恢复会话级授权（「总是允许此工具 / 此命令」），否则重建引擎后又得重新审批
  for (const t of savedState?.allowTools ?? []) {
    engine.permissions.allowToolForSession(t);
  }
  for (const c of savedState?.allowCommands ?? []) {
    engine.permissions.allowCommandForSession(c);
  }

  // 挂 fileHook 引用到 engine 上（用于 SIGINT 保存状态）
  (engine as unknown as Record<string, unknown>)["_fileHook"] = fileHook;

  // MCP 管理器：首次创建时绑定 registry 并加载配置；引擎重建时切换 registry
  // （已建立的连接不中断，工具重新注入到新 registry）
  if (!mcpManager) {
    mcpManager = new McpManager(engine.registry, loadMcpConfigs(), {
      builtin: {
        workspace: WORKSPACE,
        env: process.env,
        // 多模态 OCR 兜底：与当前 LLM 连接共用同一端点与密钥
        llm: conn
          ? { baseURL: conn.baseURL, apiKey: conn.apiKey, model }
          : process.env.OPENAI_API_KEY
            ? {
                apiKey: process.env.OPENAI_API_KEY,
                baseURL: process.env.OPENAI_BASE_URL,
                model,
              }
            : undefined,
      },
    });
  } else {
    mcpManager.attach(engine.registry);
  }

  // 命令工具（/tool add 创建，持久化于 tools.json，引擎重建后重新注册）
  registerCommandTools(engine.registry, loadCommandTools());

  return engine;
}

// ===================== /mcp 安装向导与导入 =====================

/** 打印手动安装用法 */
function printMcpAddUsage(): void {
  cliLog("用法: /mcp add <name> stdio <command...>");
  cliLog("      /mcp add <name> http|sse <url>");
  cliLog("      /mcp add          → 交互式选择模板");
  cliLog("      /mcp import [file] → 导入 Claude/Cursor 等配置");
}

/** `/mcp add`（无参数）交互式安装向导 */
async function mcpAddWizard(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    cliLog("当前环境不支持交互式向导。");
    printMcpAddUsage();
    return;
  }

  type Choice = {
    id: string;
    title: string;
    description: string;
    preset?: McpPreset;
  };
  const choices: Choice[] = [
    ...MCP_PRESETS.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      preset: p,
    })),
    {
      id: "__custom_stdio__",
      title: "自定义 stdio 命令",
      description: "手动输入本地启动命令",
    },
    {
      id: "__custom_http__",
      title: "自定义 HTTP / SSE 端点",
      description: "手动输入远程 URL 与请求头",
    },
  ];

  cliLog("\n🧩 安装 MCP 服务器：");
  choices.forEach((c, i) =>
    cliLog(`  [${i + 1}] ${c.title} — ${c.description}`),
  );
  const ans = (await question(`选择 (1-${choices.length}，回车取消): `)).trim();
  if (!ans) {
    cliLog("已取消");
    return;
  }
  const idx = parseInt(ans, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= choices.length) {
    cliLog("❌ 已取消（无效选择）");
    return;
  }
  const choice = choices[idx]!;

  let config: McpServerConfig | null = null;

  if (choice.id === "__custom_stdio__") {
    const name = (await question("名称: ")).trim();
    const cmd = (await question("启动命令（含参数，支持引号）: ")).trim();
    if (!name || !cmd) {
      cliLog("❌ 名称与命令均不能为空，已取消");
      return;
    }
    config = {
      name,
      type: "stdio",
      command: splitCommandLine(cmd),
      enabled: true,
    };
    const envAns = (
      await question("环境变量（key=value，逗号分隔，可留空）: ")
    ).trim();
    if (envAns) {
      const env: Record<string, string> = {};
      for (const pair of envAns.split(/[,\s]+/)) {
        const eq = pair.indexOf("=");
        if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      if (Object.keys(env).length > 0) config.env = env;
    }
  } else if (choice.id === "__custom_http__") {
    const name = (await question("名称: ")).trim();
    const url = (await question("URL: ")).trim();
    if (!name || !url) {
      cliLog("❌ 名称与 URL 均不能为空，已取消");
      return;
    }
    config = {
      name,
      type: /\/sse(?:[?#]|$)/i.test(url) ? "sse" : "http",
      url,
      enabled: true,
    };
    const headerAns = (
      await question("请求头（key=value，逗号分隔，可留空）: ")
    ).trim();
    if (headerAns) {
      const headers: Record<string, string> = {};
      for (const pair of headerAns.split(/[,\s]+/)) {
        const eq = pair.indexOf("=");
        if (eq > 0) headers[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      if (Object.keys(headers).length > 0) config.headers = headers;
    }
  } else {
    const preset = choice.preset!;
    const values: Record<string, string> = {};
    for (const field of preset.fields ?? []) {
      const def = field.default ?? "";
      const hint = def ? `（默认 ${def}）` : "";
      const promptText = `${field.label}${hint}: `;
      const raw = field.secret
        ? await readPassword(promptText)
        : (await question(promptText)).trim();
      const value = raw || def;
      if (field.required && !value) {
        cliLog(`❌ "${field.label}" 为必填项，已取消`);
        return;
      }
      values[field.key] = value;
    }
    config = applyMcpPreset(preset, values);
    if (config.type === "stdio") {
      config.command = (config.command ?? []).map((c) =>
        c === "" ? WORKSPACE : c,
      );
    }
  }

  // 名称冲突时自动加序号，避免覆盖已有配置
  if (mcpManager!.hasConfig(config.name)) {
    let i = 2;
    while (mcpManager!.hasConfig(`${config.name}_${i}`)) i += 1;
    config.name = `${config.name}_${i}`;
  }

  try {
    await mcpManager!.addConfig(config);
    saveMcpConfigs();
    cliLog(`✅ 已安装并连接 MCP server "${config.name}"（工具已注入）`);
  } catch (err) {
    saveMcpConfigs();
    cliLog(`⚠️  配置已保存，但连接失败: ${err}`);
    cliLog(`   可用 /mcp refresh ${config.name} 重试`);
  }
}

/** `/mcp import [file]`：导入任意受支持格式的 MCP 配置 */
async function mcpImportCommand(file?: string): Promise<void> {
  let raw: unknown;
  if (file) {
    const target = path.isAbsolute(file) ? file : path.resolve(WORKSPACE, file);
    try {
      raw = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch (err) {
      cliLog(`❌ 读取配置失败: ${err}`);
      return;
    }
  } else {
    if (!process.stdin.isTTY) {
      cliLog("非交互环境请使用 /mcp import <file>");
      return;
    }
    cliLog(
      "粘贴 MCP 配置 JSON（支持 mcpServers 格式），最后单独一行输入 EOF：",
    );
    const lines: string[] = [];
    for (;;) {
      const line = await question("");
      if (line.trim() === "EOF") break;
      lines.push(line);
      if (lines.length > 5000) {
        cliLog("❌ 输入过长，已取消");
        return;
      }
    }
    if (lines.length === 0) {
      cliLog("已取消");
      return;
    }
    try {
      raw = JSON.parse(lines.join("\n"));
    } catch (err) {
      cliLog(`❌ JSON 解析失败: ${err}`);
      return;
    }
  }

  const { configs, warnings } = normalizeMcpConfigs(raw);
  for (const w of warnings) cliLog(`⚠️  ${w}`);
  if (configs.length === 0) {
    cliLog("❌ 没有解析到有效的 MCP 服务器配置");
    return;
  }

  cliLog(`\n解析到 ${configs.length} 个 MCP 服务器：`);
  for (const c of configs) {
    const target =
      c.type === "stdio"
        ? (c.command ?? []).join(" ")
        : (c.url ?? c.builtin ?? "");
    cliLog(`  ${c.name} [${c.type}] ${target}`);
  }
  const confirm = (await question("导入以上配置？[Y/n]: "))
    .trim()
    .toLowerCase();
  if (confirm === "n" || confirm === "no") {
    cliLog("已取消");
    return;
  }

  let added = 0;
  let updated = 0;
  let failed = 0;
  for (const cfg of configs) {
    if (mcpManager!.hasConfig(cfg.name)) {
      const ans = (
        await question(
          `"${cfg.name}" 已存在，[o]覆盖 / [s]跳过（默认 s）: `,
        )
      )
        .trim()
        .toLowerCase();
      if (ans !== "o" && ans !== "overwrite") continue;
      try {
        await mcpManager!.updateConfig(cfg.name, cfg);
        updated += 1;
      } catch (err) {
        failed += 1;
        cliLog(
          `⚠️  "${cfg.name}" 连接失败: ${err}（配置已保存，可用 /mcp refresh ${cfg.name} 重试）`,
        );
      }
    } else {
      try {
        await mcpManager!.addConfig(cfg);
        added += 1;
      } catch (err) {
        failed += 1;
        cliLog(
          `⚠️  "${cfg.name}" 连接失败: ${err}（配置已保存，可用 /mcp refresh ${cfg.name} 重试）`,
        );
      }
    }
  }
  saveMcpConfigs();
  cliLog(
    `✅ 导入完成：新增 ${added}，覆盖 ${updated}，连接失败 ${failed}${
      failed > 0 ? "（失败项配置已保存）" : ""
    }`,
  );
}

// ===================== /connect 向导 =====================

/**
 * /connect 交互式向导：选择 provider → 设置 API key → 选择模型 →
 * 选择推理强度。返回新的连接配置，用户取消返回 null（不落盘）。
 */
async function connectWizard(): Promise<ConnectionConfig | null> {
  // 当前连接提示
  if (currentConnection) {
    const cur = PROVIDERS[currentConnection.provider];
    cliLog(
      `\n当前连接: ${cur?.label ?? currentConnection.provider} | 模型 ${currentConnection.model}`,
    );
  }

  // ---- 1. 选择 provider ----
  const providerKeys = Object.keys(PROVIDERS);
  cliLog("\n请选择 LLM 服务提供商:");
  providerKeys.forEach((k, i) => {
    const p = PROVIDERS[k]!;
    const hint = p.hint ? ` — ${p.hint}` : "";
    cliLog(`  [${i + 1}] ${p.label}${hint}`);
  });
  const providerAns = (
    await question(`选择 (1-${providerKeys.length}): `)
  ).trim();
  const providerIdx = parseInt(providerAns, 10) - 1;
  if (
    isNaN(providerIdx) ||
    providerIdx < 0 ||
    providerIdx >= providerKeys.length
  ) {
    cliLog("❌ 已取消（无效选择）");
    return null;
  }
  const providerKey = providerKeys[providerIdx]!;
  const preset = PROVIDERS[providerKey]!;

  // ---- 2. baseURL（自定义 provider 需手动输入）----
  let baseURL = preset.baseURL;
  if (!baseURL) {
    const b = (
      await question("API 端点 baseURL (例如 http://localhost:8000/v1): ")
    ).trim();
    if (!b) {
      cliLog("❌ 已取消");
      return null;
    }
    if (!/^https?:\/\//i.test(b)) {
      cliLog("❌ baseURL 需以 http:// 或 https:// 开头，已取消");
      return null;
    }
    baseURL = b;
  }

  // ---- 3. API key（隐藏输入）----
  const apiKey = (await readPassword(`API Key (${preset.label}): `)).trim();
  if (!apiKey) {
    cliLog("❌ API Key 不能为空，已取消");
    return null;
  }

  // ---- 4. 刷新模型列表（用 baseURL + key 请求 /models 接口），再选择 ----
  // /models 往往是「全量目录」（含向量/语音/图像/专用通道模型），选到
  // 不能对话的模型只会在第一次请求时收到 InvalidParameter，因此这里
  // 把对话模型排在前面、给非对话模型打标记，并在选定后自检一次。
  cliLog(`\n正在通过 ${baseURL} 刷新模型列表...`);
  const modelDiag = await fetchModelsWithDiagnostics(baseURL, apiKey);
  const modelResult = modelDiag.result;
  const nonChat = new Set(modelResult?.nonChat ?? []);
  let model = "";

  /** 选择/输入模型 → 自检 → 不通过则回到这里重选（除非用户坚持使用） */
  for (;;) {
    if (modelResult && modelResult.models.length > 0) {
      const total = modelResult.models.length;
      cliLog(
        `发现 ${total} 个模型 (${modelResult.endpoint})` +
          (nonChat.size > 0 ? `，其中 ${nonChat.size} 个非对话模型排在最后` : "") +
          ":",
      );
      modelResult.models.forEach((m, i) => {
        const flag = nonChat.has(m) ? "  ⚠️ 非对话模型（向量/语音/图像/专用通道…），大概率不能用作 LLM" : "";
        const ctx = modelContextWindow(modelResult.modelMeta, m);
        cliLog(`  [${i + 1}] ${m}${ctx ? `  [${formatCtxWindow(ctx)} 上下文]` : ""}${flag}`);
      });
      cliLog("  [0] 手动输入");
      const mAns = (
        await question(`选择 (1-${total}, 0=手动): `)
      ).trim();
      const mIdx = parseInt(mAns, 10);
      if (mIdx >= 1 && mIdx <= total) {
        model = modelResult.models[mIdx - 1]!;
      } else if (mIdx === 0) {
        const mm = (await question("输入模型名: ")).trim();
        if (!mm) {
          cliLog("❌ 已取消");
          return null;
        }
        model = mm;
      } else {
        cliLog("❌ 已取消（无效选择）");
        return null;
      }
    } else {
      // 打印「试过哪些端点、各自为什么失败」：只报「接口不可用」无法排查
      cliLog("⚠️  未能获取模型列表");
      for (const line of describeModelFetchFailure(baseURL, modelDiag).split("\n")) {
        cliLog(`   ${line}`);
      }
      const mm = (await question("请手动输入模型名: ")).trim();
      if (!mm) {
        cliLog("❌ 已取消");
        return null;
      }
      model = mm;
    }

    // 自检：真发一次最小对话请求，确认这个模型在这个端点上可用
    cliLog(`\n正在自检模型 ${model} ...`);
    const probe = await probeModel(baseURL, apiKey, model);
    if (probe.ok) {
      cliLog(`✅ 自检通过（${probe.latencyMs}ms）`);
      break;
    }
    cliLog(`❌ 自检失败: ${probe.error}${probe.code ? ` | ${probe.code}` : ""}`);
    for (const hint of [
      ...authErrorHints(probe.error ?? "", probe.code ?? ""),
      ...paramErrorHints(probe.error ?? "", probe.code ?? ""),
    ]) {
      cliLog(`   💡 ${hint}`);
    }
    const keep = (
      await question("重新选择模型 (回车重选) / 输入 y 仍使用该模型: ")
    )
      .trim()
      .toLowerCase();
    if (keep === "y" || keep === "yes") {
      cliLog("⚠️  已忽略自检结果，继续使用该模型（对话时可能仍失败）");
      break;
    }
  }

  // ---- 5. 推理强度 ----
  let reasoningEffort: ReasoningEffort | null = null;
  if (preset.supportsReasoningEffort) {
    cliLog("\n选择推理强度 (reasoning effort):");
    cliLog("  [1] low — 快速 / 低成本");
    cliLog("  [2] medium — 均衡");
    cliLog("  [3] high — 最强推理 / 最慢");
    cliLog("  [4] 默认 (不设置)");
    const rAns = (await question("选择 (1-4): ")).trim();
    if (rAns === "1") reasoningEffort = "low";
    else if (rAns === "2") reasoningEffort = "medium";
    else if (rAns === "3") reasoningEffort = "high";
    else if (rAns === "4") reasoningEffort = null;
    else {
      cliLog("❌ 已取消（无效选择）");
      return null;
    }
  } else {
    cliLog("ℹ️  该服务不支持推理强度设置，将使用模型默认行为");
  }

  // ---- 6. 上下文长度：/models 响应已带则直接用，否则对选定模型单体探测一次 ----
  // 该值决定引擎何时触发上下文压缩，拿不到时由引擎回退到内置模型表估算。
  let modelMeta = modelResult?.modelMeta;
  if (!modelContextWindow(modelMeta, model)) {
    const ctx = await fetchModelContext(baseURL, apiKey, model);
    if (ctx) {
      modelMeta = [
        ...(modelMeta ?? []).filter((m) => m.id !== model),
        { id: model, contextWindow: ctx },
      ];
    }
  }
  const ctxWindow = modelContextWindow(modelMeta, model);
  cliLog(
    ctxWindow
      ? `📏 上下文长度: ${formatCtxWindow(ctxWindow)}（供应商返回）`
      : "📏 供应商未提供上下文长度，将使用内置模型表估算",
  );

  return {
    provider: providerKey,
    baseURL,
    apiKey,
    model,
    reasoningEffort,
    ...(modelMeta?.length ? { modelMeta } : {}),
  };
}

/** 上下文长度紧凑展示（128000 → 128K，1000000 → 1M） */
function formatCtxWindow(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

// ===================== 任务中断 (连按两次 ESC) =====================

/** 两次 ESC 的时间窗 (ms)：间隔小于该值视为「连续按两次」 */
const DOUBLE_ESC_WINDOW_MS = 500;
/** 最近一次 ESC 按键时间戳 */
let _lastEscAt = 0;
/** 是否已打印过「运行中可输入补充信息」提示（仅提示一次） */
let _steeringHintShown = false;

/**
 * 任务运行期间监听 stdin：连续按两次 ESC 触发 engine.requestInterrupt()
 *
 * readline 保持活跃以处理行输入（运行中补充信息）；这里仅追加一个
 * raw data 监听器检测裸 ESC 字节，不抢占 stdin、不打断 readline。
 * 非 TTY 环境（管道输入）下静默跳过。
 *
 * @returns 清理函数（移除 data 监听）
 */
function startEscInterrupt(engine: TurnEngine): () => void {
  if (!process.stdin.isTTY) return () => {};

  const onData = (chunk: Buffer) => {
    const escCount = countRawEscapes(chunk);

    for (let i = 0; i < escCount; i++) {
      const now = Date.now();
      if (now - _lastEscAt <= DOUBLE_ESC_WINDOW_MS) {
        // 连续第二次 ESC → 触发优雅中断
        _lastEscAt = 0;
        engine.requestInterrupt();
        cliLog("\n⏹ 收到中断请求 (ESC ESC)，正在停止...\n");
      } else {
        _lastEscAt = now;
      }
    }
  };

  // readline 在终端模式下已维护 raw mode，直接监听裸字节即可
  process.stdin.on("data", onData);

  return () => {
    process.stdin.removeListener("data", onData);
  };
}

// ===================== Turn 运行 =====================

/**
 * 运行一轮 Turn 并渲染事件流到控制台
 *
 * 消费 engine.run() 产出的事件，按类型打印流式文本、工具执行
 * 状态、Token 用量与最终结果。PERMISSION_REQUIRED 事件本身
 * 无需在此处理（审批由引擎内部调用 approver 完成）。
 *
 * 收到 ERROR 事件且标记为可重试时，自动调用 engine.retry()
 * 重新驱动一轮（最多 MAX_RETRIES 次）。
 */
async function runTurn(
  engine: TurnEngine,
  userInput: string,
): Promise<boolean> {
  const MAX_RETRIES = 2;
  let attempts = 0;
  /** 最后一轮 Turn 的结束状态（completed / interrupted / error / ...） */
  let lastStatus: string | null = null;

  // 首次运行提示一次：运行中可直接输入补充信息
  if (!_steeringHintShown) {
    _steeringHintShown = true;
    cliLog(
      `\x1b[90m💡 任务运行中可直接输入补充信息（回车发送）；连按两次 ESC 中断\x1b[0m\n`,
    );
  }

  for (;;) {
    let errored = false;
    let willRetry = false;
    const gen = attempts === 0 ? engine.run(userInput) : engine.retry();
    const stopEscInterrupt = startEscInterrupt(engine);
    inputRouter.setSteeringTarget(engine);
    try {
      for await (const event of gen) {
        // if (
        //   event.type !== "assistant_delta" &&
        //   event.type !== "reasoning_delta"
        // ) {
        //   cliLog(`\n${event.type}: ${JSON.stringify(event.data)}`);
        // }
        switch (event.type) {
          case EventType.TURN_START:
            break;

          case EventType.ASSISTANT_DELTA:
            break;

          case EventType.PERMISSION_REQUIRED:
            // 审批由 approver 回调处理（引擎内部）
            break;

          case EventType.QUEUE_STEERING:
            // 排队的补充信息已注入为一条 user 消息，继续下一轮迭代
            cliLog(`\n⤴ 已注入补充信息: ${event.data.text}\n`);
            break;

          case EventType.INTERRUPTED:
            cliLog(`\n⏹  已中断\n`);
            break;

          case EventType.TURN_END:
            // 记录结束状态（供调用方判断是否「成功完成」，用于会话命名计数）
            lastStatus = String(event.data.status ?? "completed");
            // 终态文案由 ConsoleHook.onTurnEnd 统一输出（含 max_iterations 的「继续」提示）
            break;

          case EventType.ERROR:
            // 错误详情由 ConsoleHook 打印；这里只决定是否自动重试
            errored = true;
            if (event.data.retriable === true && attempts < MAX_RETRIES) {
              attempts++;
              willRetry = true;
              cliLog(
                `\n🔄 检测到可重试错误，正在自动重试 (${attempts}/${MAX_RETRIES})...\n`,
              );
            }
            break;

          default:
            // 所有其他事件由 ConsoleHook 处理
            break;
        }
      }
    } catch (exc) {
      cliErr(`\n❌ 引擎异常: ${exc}`);
      return false;
    } finally {
      // 任务结束（含异常/中断）后清除 steering 目标并移除 ESC 监听
      inputRouter.setSteeringTarget(null);
      stopEscInterrupt();
    }
    // 出错且已安排重试 → 用 engine.retry() 再来一轮；否则结束
    if (!errored || !willRetry) return lastStatus === "completed";
  }
}

/**
 * 后台生成会话名（第 1/3/5 次任务完成后触发）。
 *
 * 请求在后台进行、不阻塞用户输入。完成后：
 * - 若目标会话仍是当前会话且用户未手动改名 → 更新 sessionMeta 并落盘、打印提示；
 * - 若期间已切换到其它会话 → 直接写回原会话的 state 文件，避免写错会话；
 * - 用户在此间手动 /rename（nameSource=user）→ 放弃覆盖。
 *
 * 生成失败（如未配置 LLM）静默忽略，不影响主流程。
 */
async function autoNameSession(
  engine: TurnEngine,
  targetSessionId: string,
): Promise<void> {
  if (namingInFlight) return;
  namingInFlight = true;
  try {
    const clean = sanitizeSessionName(await engine.genSessionName());
    if (!clean) return;
    if (SESSION_ID === targetSessionId && sessionMeta.nameSource !== "user") {
      sessionMeta.name = clean;
      sessionMeta.nameSource = "auto";
      saveEngineState(engine);
      cliLog(`\n🏷️  会话名已生成: ${clean}\n`);
    } else if (SESSION_ID !== targetSessionId) {
      // 会话已切走：写回原会话 state（此时 sessionMeta 已指向新会话）
      updateSessionMetaFile(STATE_DIR, targetSessionId, {
        name: clean,
        nameSource: "auto",
      });
    }
  } catch {
    // 静默：命名失败不影响主流程
  } finally {
    namingInFlight = false;
  }
}

/**
 * 重置会话（reset / /clear）后同步重置命名元数据：
 * - 任务计数归零（重新从第 1/3/5 次触发自动命名）；
 * - 用户手动命名的名称保留（nameSource=user 继续生效，不再自动生成）；
 * - 自动生成的名字随历史清空而清空。
 */
function resetSessionMeta(): void {
  sessionMeta = {
    sessionId: SESSION_ID,
    name: sessionMeta.nameSource === "user" ? sessionMeta.name : undefined,
    nameSource: sessionMeta.nameSource === "user" ? "user" : undefined,
    taskCount: 0,
  };
}

// ===================== Windows 终端环境引导 =====================

/**
 * 传统控制台（conhost）下的启动引导。
 *
 * 探测到「Windows + TTY + 缺 Unicode 字形」时给出两条出路：先让 agent 用
 * winget 装 Windows Terminal + Nerd Font；装不动（或压根没配 LLM 连接，那得
 * 先把连接解决了）再打印手动教程。非 TTY、正常终端、或用户设了
 * `ZQAGENT_TERM_SETUP=0` 时不打扰。
 */
async function offerTerminalSetup(
  engine: TurnEngine,
  canUseAgent: boolean,
): Promise<void> {
  const advice = detectTerminalSetup();
  if (!advice.needed) return;

  cliLog(
    "\n⚠️  检测到传统控制台（conhost / cmd.exe）：emoji 与 Unicode 表格边框已降级为 ASCII 标记。",
  );
  cliLog(
    "    推荐安装 Windows Terminal + Nerd Font，获得与 Linux / macOS 一致的字体与配色。\n",
  );

  if (!canUseAgent) {
    cliLog(
      "ℹ️  让 agent 自动安装需要先配好 LLM 连接：输入 /connect 完成配置后重启，或按下面的教程手动安装。\n",
    );
    cliLog(renderTerminalTutorial());
    cliLog("");
    return;
  }

  cliLog("  1) 让 agent 自动安装（需逐条审批 run_shell 命令）");
  cliLog("  2) 查看手动安装教程");
  cliLog("  3) 跳过");

  let answer: string;
  try {
    answer = (await question("请选择 [1/2/3，回车=1]: ")).trim();
  } catch {
    // stdin 异常（EOF 等）→ 视为跳过，不阻断启动
    return;
  }

  if (answer === "2") {
    cliLog("");
    cliLog(renderTerminalTutorial());
    cliLog("");
    return;
  }
  if (answer !== "1" && answer !== "") return; // 回车默认走安装，其余值一律跳过

  cliLog("\n🤖 正在让 agent 安装 Windows Terminal 与 Nerd Font…\n");
  try {
    await runTurn(engine, buildTerminalInstallPrompt());
  } catch (err) {
    // 安装引导失败不应阻断启动，降级到手动教程
    cliLog(`⚠️  自动安装过程中出错: ${describeError(err)}`);
  }

  if (hasWindowsTerminal()) {
    cliLog(
      "\n✅ 已检测到 Windows Terminal，请关闭当前窗口，改用 Windows Terminal 重新打开。\n",
    );
  } else {
    cliLog(
      "\n⚠️  未检测到 Windows Terminal，自动安装可能未成功。可参考下面的教程手动安装：\n",
    );
    cliLog(renderTerminalTutorial());
    cliLog("");
  }
}

// ===================== 版本 / 用法 =====================

/** 已支持的命令行子命令（其余裸词视为未知，避免静默进入 REPL） */
const KNOWN_SUBCOMMANDS = new Set(["link", "serve", "update", "rename"]);

/**
 * CLI 版本：优先环境变量（发布构建注入 `ZQAGENT_VERSION`），
 * 其次读取 core 的 package.json（源码运行 / dist 运行路径一致），最后回退 dev。
 */
function cliVersion(): string {
  const env = process.env.ZQAGENT_VERSION?.trim();
  if (env) return env;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const req = createRequire(import.meta.url);
    const pkg = req("../../package.json") as { version?: string };
    if (pkg?.version) return pkg.version;
  } catch {
    /* 打包（SEA）环境取不到包版本，忽略 */
  }
  return process.env.npm_package_version ?? "dev";
}

/** 打印命令行用法（子命令 + 常用选项） */
function printCliUsage(): void {
  cliLog(`ZQAgent CLI v${cliVersion()}`);
  cliLog("");
  cliLog("用法：");
  cliLog("  zqagent                        交互式会话（默认）");
  cliLog("  zqagent serve [选项]           以 headless 方式常驻为可被 Hub 管理的节点");
  cliLog("  zqagent update [--status|--check|--now|--rollback]");
  cliLog("                                 查看/手动触发节点自动更新");
  cliLog("  zqagent link [--hub <url>] [--username <邮箱/手机号> --password <密码>]");
  cliLog("               [--code <接入码>] [--label 名称]");
  cliLog("                                 把本机节点接入 Hub（账号直连或接入码；本机有 server 时热接入）");
  cliLog("  zqagent rename <名称>          修改节点在 Hub 显示的名称（本机与 Hub 记录一起更新）");
  cliLog("");
  cliLog("serve 选项：--port <n>  --host <addr>  --data-dir <dir>");
  cliLog("            --hub <url> --enroll-code <码> --label <名称>   （启动即接入）");
  cliLog("            --hub <url> --username <邮箱/手机号> --password <密码>（账号接入）");
  cliLog("其它选项：--resume <会话ID>   --debug   --help/-h   --version/-v");
}

// ===================== CLI 主循环 =====================

/**
 * CLI 主循环
 *
 * 打印启动横幅 → 循环读取用户输入：quit/exit 退出，
 * reset 重建引擎（清空会话），其余输入交给 runTurn 执行。
 */
async function main() {
  dlog("main", "进入 main()");

  // 子命令 / 选项：link、serve、--help、--version
  const subcommand = process.argv[2];
  if (subcommand === "--help" || subcommand === "-h") {
    printCliUsage();
    rl.close();
    process.exit(0);
  }
  if (subcommand === "--version" || subcommand === "-v") {
    cliLog(`zqagent v${cliVersion()}`);
    rl.close();
    process.exit(0);
  }
  if (subcommand === "link") {
    const ok = await runLinkCommand(process.argv.slice(3), {
      rl,
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    });
    rl.close();
    process.exit(ok ? 0 : 1);
  }
  if (subcommand === "rename") {
    const ok = await runRenameCommand(process.argv.slice(3));
    rl.close();
    process.exit(ok ? 0 : 1);
  }
  if (subcommand === "serve") {
    rl.close();
    await runServeCommand(process.argv.slice(3));
    return;
  }
  if (subcommand === "update") {
    const code = await runUpdateCommand(process.argv.slice(3));
    rl.close();
    process.exit(code);
  }
  // 未知子命令（裸词）：明确报错并给出用法，而不是静默进入交互 REPL
  if (subcommand && !subcommand.startsWith("-") && !KNOWN_SUBCOMMANDS.has(subcommand)) {
    cliErr(
      `未知子命令「${subcommand}」（当前 CLI 版本 v${cliVersion()}）。`,
    );
    cliErr(
      "若你在文档里看到 `zqagent serve` / `zqagent link`，说明本机 CLI 版本过旧，请升级后重试。",
    );
    cliLog("");
    printCliUsage();
    rl.close();
    process.exit(2);
  }

  // 启用 bracketed paste：终端粘贴多行文本时发送 ESC[200~/ESC[201~ 标记，
  // 便于 InputRouter 区分「粘贴中的换行」与「手按 Enter」，避免粘贴即提交。
  // process.on("exit") 覆盖 quit / Ctrl+C / 异常等所有退出路径，保证关闭标记。
  if (process.stdin.isTTY && process.stdout.isTTY) {
    cliWrite("\x1b[?2004h");
    process.on("exit", () => cliWrite("\x1b[?2004l"));
  }

  // 加载已保存的 LLM 连接配置（若有），供横幅展示与引擎构建使用
  currentConnection = debugStage("loadConnection", () => loadConnection());
  // 空模型显示成「未选择」，而不是表格里空一格让人以为界面坏了
  const bannerModel = (currentConnection?.model ?? MODEL) || "未选择";
  const bannerProvider = currentConnection
    ? (PROVIDERS[currentConnection.provider]?.label ??
      currentConnection.provider)
    : process.env.OPENAI_API_KEY
      ? "环境变量"
      : "未配置";

  // 打印启动横幅：大号字标 + 渐变（见 banner.ts），随后是信息表
  const wsShort =
    WORKSPACE.length > 44
      ? WORKSPACE.slice(0, 22) + "…" + WORKSPACE.slice(-21)
      : WORKSPACE;
  cliWrite(renderBanner({ unicode: UNICODE_SUPPORTED }) + "\n");
  const bannerMd = [
    "| 项目 | 内容 |",
    "| :--- | :--- |",
    `| 会话ID | ${SESSION_ID} |`,
    `| 版本 | v${cliVersion()} |`,
    `| 连接 | ${bannerProvider} |`,
    `| 模型 | ${bannerModel} |`,
    `| 工作区 | ${wsShort} |`,
    `| 模式 | INTERACTIVE (需审批) |`,
    `| Agent | ${agentRegistry.current} |`,
    "",
    "### 命令",
    "",
    "- /plan(/p) /interactive(/i) /auto(/a) /discuss(/d)",
    "- /mode(/m) /model /clear /connect /sessions",
    "- /history /agent /agents /mcp /tools /help(/h)",
    "- quit / exit / reset",
    "- 任务运行中: 直接输入并回车 → 补充信息; 连按两次 ESC → 中断",
  ].join("\n");

  dlog("banner", `打印启动横幅（会话 ${SESSION_ID}，工作区 ${WORKSPACE}）`);
  const bannerRenderer = new MarkdownRenderer({ unicode: UNICODE_SUPPORTED });
  cliWrite(
    bannerRenderer.push(bannerMd + "\n") + bannerRenderer.flush(),
  );
  cliLog("  输入 'quit' 退出, 'reset' 重置会话\n");
  cliLog("  © 成都志前科技有限公司\n");

  // 未配置任何 LLM 连接时，首次进入直接引导完成配置：
  // 选择 provider → 输入 API Key → 选择模型 → 推理强度。
  // 配置结果写入内存后，下方 buildEngine() 会自动采用，无需重建引擎。
  if (!currentConnection && !process.env.OPENAI_API_KEY) {
    // 非 TTY（管道/脚本）跳过交互，避免阻塞，改为手动指引
    if (process.stdin.isTTY) {
      cliLog("⚠️  尚未配置 LLM 连接，开始首次配置\n");
      const cfg = await connectWizard();
      if (cfg) {
        try {
          saveConnection(cfg);
          currentConnection = cfg;
          const label = PROVIDERS[cfg.provider]?.label ?? cfg.provider;
          const effort = cfg.reasoningEffort
            ? ` | 推理强度 ${cfg.reasoningEffort}`
            : "";
          cliLog(`✅ 已连接 ${label} → ${cfg.model}${effort}`);
          cliLog("  💾 API Key 已加密保存到本地\n");
        } catch (err) {
          cliLog(`❌ 连接配置保存失败: ${err}\n`);
        }
      } else {
        cliLog("  已跳过，稍后可运行 /connect 完成配置\n");
      }
    } else {
      cliLog(
        "⚠️  尚未配置 LLM 连接，请运行 /connect 配置（provider / key / 模型）\n",
      );
    }
  }

  // 设置 CLI 交互处理器
  setQuestionHandler(async (qText, options, allowText, multi) => {
    cliLog(`\n💬 Agent 提问`);
    cliLog();
    cliLog(qText);

    if (options.length > 0) {
      // 选项以 Markdown 表格渲染（序号 + 选项），剥离 ANSI 保证对齐
      const mdText = [
        "| 序号 | 选项 |",
        "| :---: | :--- |",
        ...options.map(
          (opt, i) =>
            `| ${i + 1} | ${opt.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`,
        ),
      ].join("\n");
      const renderer = new MarkdownRenderer({ color: false, unicode: UNICODE_SUPPORTED });
      const rendered = renderer.push(mdText + "\n") + renderer.flush();
      cliWrite("\n" + rendered.trimEnd() + "\n");
      if (allowText) {
        cliLog("（也可直接输入你的想法）");
      }
    }

    if (options.length > 0) {
      // 循环直到拿到合法回答：支持数字序号（单选/多选）或自由文字
      for (;;) {
        const hint = `序号${multi ? "（可多个，逗号分隔）" : ""}${allowText ? "或文字" : ""}`;
        const raw = (await question(`  请选择 ${hint}: `)).trim();
        if (!raw) continue;

        // 纯数字/分隔符输入 → 视为序号，解析失败则提示重试（不误当文字）
        if (/^[\d\s,，、;；]+$/.test(raw)) {
          const picks = parsePicks(raw, options.length);
          if (picks) {
            const selected = picks.map((p) => options[p - 1]!);
            return multi ? selected.join(", ") : selected[0]!;
          }
          cliLog(
            `   ❌ 序号无效，请输入 1-${options.length} 之间${multi ? "的序号（可多个）" : "的序号"}`,
          );
          continue;
        }

        // 非纯序号 → 自由文字
        if (allowText) return raw;
        cliLog(
          `   ❌ 请输入序号（1-${options.length}）${multi ? "或多个序号" : ""}${allowText ? "或文字" : ""}`,
        );
      }
    }
    const answer = await question("  请输入回答: ");
    return answer.trim();
  });

  /**
   * 设置计划处理器
   */
  setPlanHandler(async (plan) => {
    cliLog(`\n📋 计划提案`);
    cliLog();
    // plan 文本用 Markdown 渲染（标题/列表/表格/代码块都会漂亮显示）。
    // 计划需经用户批准，必须完整显示，不做任何截断/省略。
    const renderer = new MarkdownRenderer({ unicode: UNICODE_SUPPORTED });
    const rendered = renderer.push(plan + "\n") + renderer.flush();
    cliWrite(rendered.trimEnd() + "\n");
    while (true) {
      const answer = await question("  [Y] 批准并执行  [D] 拒绝: ");
      const lower = answer.trim().toLowerCase();
      if (lower === "y" || lower === "yes")
        return { approved: true, mode: "interactive" };
      if (lower === "d" || lower === "n") {
        const fb = await question("  反馈意见 (可选): ");
        return { approved: false, feedback: fb || "计划被拒绝" };
      }
    }
  });

  /**
   * 设置目录处理器
   */
  setDirectoryHandler(async (reason, suggestedPath, writable) => {
    cliLog(`\n📁 目录访问请求`);
    cliLog();
    cliLog(`原因: ${reason}`);
    if (suggestedPath) cliLog(`建议路径: ${suggestedPath}`);
    cliLog(`权限: ${writable ? "读写" : "只读"}`);
    while (true) {
      const answer = await question("  [Y] 批准  [D] 拒绝: ");
      const lower = answer.trim().toLowerCase();
      if (lower === "y" || lower === "yes")
        return { granted: true, path: suggestedPath };
      if (lower === "d" || lower === "n") return { granted: false };
    }
  });

  // 尝试恢复
  const savedState = resumeId
    ? FileLogHook.loadState(resumeId, STATE_DIR)
    : null;

  // 初始化当前会话的命名元数据（resume 或复用空会话时从 state 文件读取）。
  // 新建会话没有 state 文件，existsSync 前置判断避免 loadState 打印 ENOENT 报错。
  const metaStateFile = path.join(STATE_DIR, `${SESSION_ID}_state.json`);
  const stateForMeta =
    savedState ??
    (fs.existsSync(metaStateFile)
      ? FileLogHook.loadState(SESSION_ID, STATE_DIR)
      : null);
  sessionMeta = {
    sessionId: SESSION_ID,
    name: stateForMeta?.name,
    nameSource: stateForMeta?.nameSource,
    taskCount: stateForMeta?.taskCount ?? 0,
  };

  if (resumeId) {
    if (savedState) {
      cliLog(`║  模式: 恢复会话                                 ║`);
      cliLog(
        `║  消息数: ${String(savedState.messages.length).padEnd(36)}║`,
      );
    }
  }

  let engine = debugStage("buildEngine", () =>
    buildEngine(SESSION_ID, savedState),
  );

  // 让用户明确知道当前的 shell 隔离能力与免审策略：
  // 沙箱未生效时（典型是 Windows）工作区判定只是降噪，不是安全边界
  cliLog(
    `🛡  shell 免审: ${PERM_CONFIG.shellPolicy} | 沙箱: ${describeSandbox(SANDBOX_PLAN)}`,
  );

  // 启动时连接已配置的 MCP 服务器并注入工具（失败不阻断启动）
  const mcpResult = await debugStageAsync("mcp.connectAll", () =>
    mcpManager!.connectAll(),
  );
  if (mcpResult.connected.length > 0) {
    cliLog(`📡 MCP 已连接: ${mcpResult.connected.join(", ")}`);
  }
  for (const f of mcpResult.failed) {
    cliLog(`⚠️  MCP "${f.name}" 连接失败: ${f.error}`);
  }

  // 动态列出实际注册且启用中的工具（含 MCP 注入），取代旧版硬编码清单，
  // 避免「横幅声明 18 个含 web_search，实际未下发」这类不一致。
  {
    const toolNames = engine.registry
      .schemas()
      .map((s) => s.function.name)
      .sort();
    cliLog(`🧰 可用工具 ${toolNames.length} 个: ${toolNames.join(", ")}`);
  }

  // Windows 传统控制台：给出「让 agent 装终端 / 看教程」两条出路
  // （判定与文案见 terminalSetup.ts；未配置 LLM 连接时优先提示 /connect）
  await debugStageAsync("terminalSetup", () =>
    offerTerminalSetup(
      engine,
      Boolean(currentConnection) || Boolean(process.env.OPENAI_API_KEY),
    ),
  );

  // SIGINT / Ctrl+C 处理：保存状态并显示会话 ID
  _exitHandler = () => {
    const finish = (): void => {
      saveEngineState(engine);
      void mcpManager?.closeAll(); // 优雅断开 MCP 子进程（不阻塞退出）
      cliLog(`\n\n📋 会话ID: ${SESSION_ID}`);
      cliLog(`💾 状态已保存，可通过以下命令恢复:`);
      // 用 `zqagent` 而不是开发期的 `tsx src/cli/index.ts`：这条提示是给最终用户看的，
      // 他们装的是 npm 包/单文件，没有源码可跑 tsx。
      cliLog(`   zqagent --resume ${SESSION_ID}`);
      cliLog(`   或 zqagent --r ${SESSION_ID}\n`);
      rl.close();
      process.exit(0);
    };
    // 快照是异步的：给它最多 1s 落盘窗口（git 卡住时也不会退不出去）
    const flush = vcsHook?.flush() ?? Promise.resolve();
    void Promise.race([
      flush,
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]).then(finish, finish);
  };
  process.on("SIGINT", _exitHandler);
  process.on("SIGTERM", _exitHandler);

  // Tab 键：循环切换 询问 → 计划 → 自动
  inputRouter.setTabHandler(() => {
    // 仅当停在主提示符上才原地重绘（保留已输入内容）；
    // 审批/提问挂起时不动其提示符，避免把问题文案覆盖掉。
    const atMainPrompt =
      inputRouter.currentPrompt() === mainPrompt(engine).slice(1);
    const next = cycleMode(engine);
    saveEngineState(engine);
    cliLog(`✅ 模式 → ${next} (${MODE_LABEL[next]})  [Tab 切换]`);
    if (atMainPrompt) inputRouter.refreshPrompt(mainPrompt(engine));
  });

  // 恢复模式：检查是否有未完成的挂起 task
  if (resumeId && savedState) {
    cliLog("📋 正在恢复会话...\n");
    for await (const event of engine.resume()) {
      if (event.type === EventType.TURN_START) continue;
      if (event.type === EventType.ASSISTANT_DELTA) continue;
    }
    cliLog("✅ 会话恢复完成");
    printLastAssistantMessage(savedState.messages);
    cliLog("");
  }

  dlog("loop", "进入交互主循环，等待输入（quit/exit 退出）");

  try {
    while (true) {
      let input: string;
      try {
        input = await question(mainPrompt(engine));
      } catch (err) {
        // stdin 已 EOF（管道/脚本模式）→ 优雅退出
        if ((err as NodeJS.ErrnoException)?.code === "ERR_USE_AFTER_CLOSE") {
          break;
        }
        throw err;
      }

      // 退出命令
      if (
        input.trim().toLowerCase() === "quit" ||
        input.trim().toLowerCase() === "exit"
      ) {
        // 退出前保存会话状态（与 Ctrl+C 一致），可用 /sessions 或 --resume 恢复
        await vcsHook?.flush(); // 等快照落盘，避免最后一次改动没被记录
        saveEngineState(engine);
        cliLog(`💾 会话状态已保存 (会话ID: ${SESSION_ID})`);
        cliLog("再见！");
        break;
      }

      // 重置会话（重建引擎，清空历史与 todo）
      if (input.trim().toLowerCase() === "reset") {
        engine = buildEngine(SESSION_ID);
        resetSessionMeta();
        cliLog("✅ 会话已重置\n");
        continue;
      }

      // 忽略空输入
      if (!input.trim()) continue;

      // 斜杠命令
      if (input.trim().startsWith("/")) {
        const cmd = input.trim();
        const parts = cmd.split(/\s+/);
        const name = parts[0]!.toLowerCase();
        const arg = parts[1] ?? "";

        switch (name) {
          case "/help":
          case "/h":
            cliLog("\n📋 可用命令:");
            cliLog("  /plan /p        → 切换为计划模式 (只读 + 提案)");
            cliLog("  /interactive /i → 切换为交互式审批模式 (默认)");
            cliLog("  /auto /a        → 切换为全自动模式 (无需审批)");
            cliLog("  /discuss /d     → 切换为讨论模式 (只读对话)");
            cliLog("  /mode /m        → 显示当前模式");
            cliLog("  Tab             → 循环切换 询问/计划/自动 模式");
            cliLog(
              "  /connect        → 连接 LLM（选 provider → key → 模型 → 推理强度）",
            );
            cliLog("  /connect rm     → 清除全部连接配置（回退到环境变量）");
            cliLog("  /providers      → 列出已配置的 LLM 供应商");
            cliLog("  /models         → 列出各供应商及其可用模型列表");
            cliLog("  /use <序号|id>  → 切换当前生效供应商");
            cliLog("  /rm <序号|id>   → 删除指定供应商");
            cliLog("  /sessions       → 列出已保存会话并选择恢复");
            cliLog("  /rename <名称>  → 手动修改当前会话名（之后不再自动生成）");
            cliLog("  /rename         → 显示当前会话名");
            cliLog("  /history        → 列出当前会话的用户指令");
            cliLog("  /link <注册码> [Hub地址] → 凭注册码把本机节点接入 Hub");
            cliLog("  /model <id>     → 切换 LLM 模型");
            cliLog("  /model          → 显示当前模型");
            cliLog("  /agent <name>   → 切换 agent (Prompt + 可选模型)");
            cliLog("  /agents         → 列出所有 agent");
            cliLog("  /agent add <name> <prompt...>  → 新增 agent");
            cliLog("  /agent edit <name> <prompt...> → 修改 agent Prompt");
            cliLog("  /agent rm <name> → 删除 agent");
            cliLog("  /agent show [name] → 查看 agent 详情");
            cliLog("  /mcp            → 列出 MCP 服务器");
            cliLog("  /mcp add        → 交互式安装（模板/自定义/内置 OCR）");
            cliLog("  /mcp add <name> stdio <cmd...>|http|sse <url> → 添加");
            cliLog("  /mcp import [file] → 导入 Claude/Cursor 等配置");
            cliLog("  /mcp rm|enable|disable|refresh [name]");
            cliLog("  /tools          → 列出所有工具");
            cliLog("  /tool add <name> <cmd...> → 添加命令工具");
            cliLog("  /tool rm|disable|enable <name>");
            cliLog("  /clear          → 清空会话，重建引擎");
            cliLog("  /vcs            → 查看变更追踪状态");
            cliLog("  /changes [序号] → 列出本会话的文件改动 / 查看某轮 patch");
            cliLog("  /restore <序号> [文件...] → 从快照恢复文件");
            cliLog("  /help /h        → 显示本帮助");
            cliLog("  quit / exit     → 退出");
            cliLog("  reset           → 重置会话");
            cliLog("  任务运行中直接输入并回车 → 补充信息（下一迭代生效）");
            cliLog("  任务运行中连按两次 ESC → 中断当前任务\n");
            break;

          case "/plan":
          case "/p":
            engine.permissions.mode = Mode.PLAN;
            saveEngineState(engine);
            cliLog(`✅ 模式 → plan (只读探索 + 计划提案)`);
            break;

          case "/interactive":
          case "/i":
            engine.permissions.mode = Mode.INTERACTIVE;
            saveEngineState(engine);
            cliLog(`✅ 模式 → interactive (逐步审批)`);
            break;

          case "/auto":
          case "/a":
            engine.permissions.mode = Mode.AUTO;
            saveEngineState(engine);
            cliLog(`✅ 模式 → auto (全自动，无需审批)`);
            break;

          case "/discuss":
          case "/d":
            engine.permissions.mode = Mode.DISCUSS;
            saveEngineState(engine);
            cliLog(`✅ 模式 → discuss (只读对话)`);
            break;

          case "/mode":
          case "/m":
            cliLog(`📋 当前模式: ${engine.permissions.mode}`);
            break;

          // ---- 变更追踪：查看 / 恢复本会话的快照 ----
          case "/vcs": {
            if (!sessionVcs || !sessionVcs.enabled) {
              cliLog(`📋 变更追踪未启用（${resolveVcsPlan(WORKSPACE, { mode: PERM_CONFIG.vcs.mode }).reason}）`);
              break;
            }
            const turns = await sessionVcs.listTurns();
            cliLog(`📋 变更追踪: ${sessionVcs.plan.mode}｜快照 ${turns.length} 个`);
            cliLog(`   ${sessionVcs.plan.reason}`);
            if (vcsHook?.lastError) cliLog(`   ⚠️ 最近一次快照失败: ${vcsHook.lastError}`);
            const last = turns[turns.length - 1];
            if (last) {
              cliLog(`   最近: #${last.turn} ${last.files.length} 个文件（${last.status}）`);
            }
            cliLog("   用 /changes 查看明细，/restore <序号> 恢复");
            break;
          }

          case "/changes": {
            if (!sessionVcs || !sessionVcs.enabled) {
              cliLog("📋 变更追踪未启用");
              break;
            }
            await vcsHook?.flush();
            const turns = await sessionVcs.listTurns();
            if (!turns.length) {
              cliLog("📋 本会话还没有文件改动");
              break;
            }
            // /changes [n]：查看第 n 个快照的 patch；不带参数则列出全部
            const n = Number(arg);
            if (Number.isFinite(n) && n > 0) {
              const patch = await sessionVcs.diffTurn(n);
              cliLog(patch.trim() ? patch.trimEnd() : `（快照 #${n} 无内容）`);
              break;
            }
            for (const t of turns) {
              const time = t.ts ? t.ts.replace("T", " ").slice(0, 19) : "";
              cliLog(`  #${t.turn}  ${time}  ${t.status}  ${t.files.length} 个文件`);
              for (const f of t.files.slice(0, 8)) cliLog(`      ${f}`);
              if (t.files.length > 8) cliLog(`      … 另有 ${t.files.length - 8} 个`);
            }
            cliLog("  用 /changes <序号> 查看 patch，/restore <序号> [文件...] 恢复");
            break;
          }

          case "/restore": {
            if (!sessionVcs || !sessionVcs.enabled) {
              cliLog("📋 变更追踪未启用");
              break;
            }
            const rest = cmd.split(/\s+/).slice(1);
            const n = Number(rest[0]);
            if (!Number.isFinite(n) || n <= 0) {
              cliLog("用法: /restore <快照序号> [文件...]（省略文件则恢复该轮全部）");
              break;
            }
            await vcsHook?.flush();
            const paths = rest.slice(1);
            const result = await sessionVcs.restoreTurn(n, paths.length ? { paths } : {});
            if (result.restored.length) {
              cliLog(`✅ 已恢复 ${result.restored.length} 个文件: ${result.restored.join(", ")}`);
            }
            if (result.overwritten.length) {
              cliLog(`   ⚠️ 其中 ${result.overwritten.length} 个覆盖了现有改动: ${result.overwritten.join(", ")}`);
            }
            const missing = result.missing ?? [];
            if (missing.length) {
              cliLog(`   ℹ️ 该快照里没有: ${missing.join(", ")}`);
            }
            if (!result.restored.length) cliLog("（没有文件被恢复）");
            break;
          }

          case "/model":
            if (arg) {
              engine.model = arg;
              // 已配置连接时同步持久化，重启后仍生效
              if (currentConnection) {
                currentConnection.model = arg;
                saveConnection(currentConnection);
                cliLog(`✅ 模型 → ${arg}（已保存）`);
              } else {
                cliLog(`✅ 模型 → ${arg}`);
              }
            } else {
              cliLog(`📋 当前模型: ${engine.model}`);
            }
            break;

          case "/connect": {
            const sub = (parts[1] ?? "").toLowerCase();

            // /connect rm → 清除配置，回退环境变量
            if (sub === "rm" || sub === "remove" || sub === "clear") {
              clearConnection();
              currentConnection = null;
              cliLog("✅ 已清除连接配置");
              engine = buildEngine(SESSION_ID);
              cliLog("  ↺ 已回退到环境变量配置\n");
              break;
            }

            const cfg = await connectWizard();
            if (!cfg) break;

            try {
              saveConnection(cfg);
              currentConnection = cfg;
              engine = buildEngine(SESSION_ID);
            } catch (err) {
              cliLog(`❌ 连接配置失败: ${err}`);
              cliLog(
                "   请检查 baseURL 格式与网络可达性，重新 /connect\n",
              );
              break;
            }

            const label = PROVIDERS[cfg.provider]?.label ?? cfg.provider;
            const effort = cfg.reasoningEffort
              ? ` | 推理强度 ${cfg.reasoningEffort}`
              : "";
            cliLog(`✅ 已连接 ${label} → ${cfg.model}${effort}`);
            cliLog("  💾 API Key 已加密保存到本地\n");
            break;
          }

          case "/providers":
          case "/provider": {
            const list = listConnections();
            if (list.length === 0) {
              cliLog("📋 暂无已保存的供应商（运行 /connect 添加）");
              break;
            }
            cliLog(`\n📋 LLM 供应商 (${list.length}):`);
            list.forEach((p, i) => {
              cliLog(
                `  ${p.active ? "▶ " : "  "}[${i + 1}] ${p.name} → ${p.model} (${p.baseURL || "默认端点"})`,
              );
            });
            cliLog("  用 /use <序号|id> 切换，/rm <序号|id> 删除\n");
            break;
          }

          case "/models": {
            const list = listConnections();
            if (list.length === 0) {
              cliLog("📋 暂无已保存的供应商（运行 /connect 添加）");
              break;
            }
            cliLog(`\n📋 供应商及可用模型 (${list.length}):`);
            for (const [i, p] of list.entries()) {
              const label = PROVIDERS[p.provider]?.label ?? p.provider;
              cliLog(
                `  ${p.active ? "▶ " : "  "}[${i + 1}] ${p.name} (${label}) · 当前模型 ${p.model}`,
              );
              cliLog(`       ${p.baseURL || "默认端点"}`);
              const cfg = loadConnectionById(p.id);
              if (!cfg) continue;
              const diag = await fetchModelsWithDiagnostics(cfg.baseURL, cfg.apiKey, p.model);
              const result = diag.result;
              if (!result || result.models.length === 0) {
                cliLog(`       ⚠️  未能获取模型列表`);
                for (const line of describeModelFetchFailure(cfg.baseURL, diag).split("\n")) {
                  cliLog(`       ${line}`);
                }
                continue;
              }
              // 顺带落盘上下文长度：引擎下次装配即按真实窗口计算压缩阈值
              saveProviderModelMeta(p.id, result.modelMeta);
              const nonChat = new Set(result.nonChat);
              cliLog(`       共 ${result.models.length} 个模型:`);
              result.models.forEach((m) => {
                const flag = nonChat.has(m) ? "  ⚠️ 非对话" : "";
                const cur = m === p.model ? "  ◀ 当前" : "";
                const ctx = modelContextWindow(result.modelMeta, m);
                cliLog(
                  `         - ${m}${ctx ? `  [${formatCtxWindow(ctx)} 上下文]` : ""}${flag}${cur}`,
                );
              });
            }
            // 上面可能写入了当前生效供应商的元数据：同步内存副本，供后续重建引擎使用
            currentConnection = loadConnection() ?? currentConnection;
            cliLog("  用 /use <序号|id> 切换，/model <id> 切换模型\n");
            break;
          }

          case "/use": {
            if (!arg) {
              cliLog("用法: /use <序号|id>（/providers 查看）");
              break;
            }
            const list = listConnections();
            const target = /^\d+$/.test(arg)
              ? list[Number(arg) - 1]
              : list.find((p) => p.id === arg);
            if (!target) {
              cliLog(`❌ 未找到供应商: ${arg}`);
              break;
            }
            if (useConnection(target.id)) {
              currentConnection = loadConnection();
              engine = buildEngine(SESSION_ID);
              cliLog(`✅ 已切换供应商 → ${target.name}（${target.model}）`);
            } else {
              cliLog(`❌ 切换失败: ${arg}`);
            }
            break;
          }

          case "/rm": {
            if (!arg) {
              cliLog("用法: /rm <序号|id>（/providers 查看）");
              break;
            }
            const list = listConnections();
            const target = /^\d+$/.test(arg)
              ? list[Number(arg) - 1]
              : list.find((p) => p.id === arg);
            if (!target) {
              cliLog(`❌ 未找到供应商: ${arg}`);
              break;
            }
            if (target.id === BUILTIN_PROVIDER_ID) {
              cliLog(
                "❌ 平台内置模型不可删除（接入 Hub 后自动配置，Key 由平台托管）。\n" +
                  "   如需改用其它模型：/connect 选择或添加供应商后设为默认。",
              );
              break;
            }
            if (removeConnection(target.id)) {
              currentConnection = loadConnection();
              engine = buildEngine(SESSION_ID);
              cliLog(`✅ 已删除供应商 ${target.name}`);
            } else {
              cliLog(`❌ 删除失败: ${arg}`);
            }
            break;
          }

          case "/sessions": {
            // 先落盘当前会话状态（让当前会话也出现在列表中，切走后可再切回）
            saveEngineState(engine);

            const sessions = listSessions();
            if (sessions.length === 0) {
              cliLog("📋 暂无保存的会话（对话过程中退出时会保存状态）");
              break;
            }

            cliLog(`\n📋 会话列表 (${sessions.length} 个):`);
            sessions.forEach((s, i) => {
              const cur = s.sessionId === SESSION_ID ? "▶ " : "  ";
              const msgCount = s.messages?.length ?? 0;
              const savedAt = s.savedAt
                ? s.savedAt.replace("T", " ").slice(0, 19)
                : "未知";
              const displayName = s.name?.trim() || "(未命名)";
              cliLog(
                `  ${cur}[${i + 1}] ${displayName}${s.sessionId === SESSION_ID ? " (当前)" : ""}`,
              );
              cliLog(
                `      ID: ${s.sessionId} | 模型: ${s.model} | 消息: ${msgCount} | 最后保存: ${savedAt}`,
              );
            });

            const ans = (
              await question(
                `\n选择要恢复的会话 (1-${sessions.length}, 0=取消): `,
              )
            ).trim();
            if (ans === "" || ans === "0") {
              cliLog("已取消");
              break;
            }
            const idx = parseInt(ans, 10);
            if (isNaN(idx) || idx < 1 || idx > sessions.length) {
              cliLog("❌ 无效选择");
              break;
            }
            const target = sessions[idx - 1]!;
            if (target.sessionId === SESSION_ID) {
              cliLog("ℹ️  已是当前会话");
              break;
            }

            // 恢复目标会话
            const savedState = FileLogHook.loadState(
              target.sessionId,
              STATE_DIR,
            );
            if (!savedState) {
              cliLog(`❌ 无法加载会话 "${target.sessionId}"`);
              break;
            }
            SESSION_ID = target.sessionId;
            // 切会话前先把上一会话的待落盘快照写完
            await vcsHook?.flush();
            engine = buildEngine(SESSION_ID, savedState);
            // 重建目标会话的命名元数据（name/nameSource/taskCount）
            sessionMeta = {
              sessionId: SESSION_ID,
              name: savedState.name,
              nameSource: savedState.nameSource,
              taskCount: savedState.taskCount ?? 0,
            };
            const targetName = savedState.name?.trim();
            cliLog(`✅ 已切换到会话 ${SESSION_ID}`);
            if (targetName) cliLog(`   会话名: ${targetName}`);
            cliLog(
              `   模型: ${savedState.model} | 消息: ${savedState.messages.length} 条`,
            );
            cliLog("📋 正在恢复会话...\n");
            for await (const event of engine.resume()) {
              if (event.type === EventType.TURN_START) continue;
              if (event.type === EventType.ASSISTANT_DELTA) continue;
            }
            cliLog("✅ 会话恢复完成");
            printLastAssistantMessage(savedState.messages);
            cliLog("");
            break;
          }

          case "/rename": {
            // 取命令后剩余全文作为名称（支持空格），空则显示当前名
            const newName = cmd.replace(/^\/rename\s*/i, "").trim();
            if (!newName) {
              if (sessionMeta.name) {
                const src =
                  sessionMeta.nameSource === "user" ? "用户手动" : "自动生成";
                cliLog(`📋 当前会话名: ${sessionMeta.name}（${src}）`);
              } else {
                cliLog("📋 当前会话尚未命名");
              }
              break;
            }
            const capped = newName.length > 30 ? newName.slice(0, 30) : newName;
            sessionMeta.name = capped;
            sessionMeta.nameSource = "user";
            saveEngineState(engine);
            cliLog(
              `✅ 会话名已更新: ${capped}（后续不再自动生成）`,
            );
            break;
          }

          case "/history": {
            const userMsgs = engine.messages.filter((m) => m.role === "user");
            if (userMsgs.length === 0) {
              cliLog("📋 当前会话暂无用户指令");
              break;
            }
            cliLog(`\n📋 用户指令列表 (${userMsgs.length} 条):`);
            userMsgs.forEach((m, i) => {
              const ts = m.ts
                ? new Date(m.ts).toISOString().replace("T", " ").slice(0, 19)
                : "";
              const flat = m.content.replace(/\n/g, "↵");
              const preview = flat.length > 60 ? flat.slice(0, 60) + "…" : flat;
              cliLog(`  [${i + 1}] ${preview}${ts ? `  (${ts})` : ""}`);
            });
            cliLog("");
            break;
          }

          case "/agent":
          case "/agents": {
            const sub = (parts[1] ?? "").toLowerCase();

            // 无子命令 / list：列出所有 agent
            if (!sub || sub === "list" || sub === "ls") {
              const all = agentRegistry.list();
              cliLog(`\n📋 Agents (${all.length} 个):`);
              for (const a of all) {
                const cur = a.name === agentRegistry.current ? "▶ " : "  ";
                const model = a.model ? ` [模型: ${a.model}]` : "";
                cliLog(
                  `${cur}${a.name}${model} — ${a.description ?? "自定义 agent"}`,
                );
              }
              cliLog(
                `  当前: ${agentRegistry.current} | 模式: ${engine.permissions.mode}\n`,
              );
              break;
            }

            // 新增 agent：/agent add <name> <prompt...>
            if (sub === "add" || sub === "new") {
              const name = parts[2];
              const prompt = parts.slice(3).join(" ").trim();
              if (!name || !prompt) {
                cliLog("用法: /agent add <name> <prompt...>");
                break;
              }
              if (agentRegistry.has(name)) {
                cliLog(`❌ Agent "${name}" 已存在（用 /agent edit 修改）`);
                break;
              }
              agentRegistry.add({
                name,
                prompt,
                description: "自定义 agent",
              });
              saveAgentsToFile(agentRegistry.list());
              cliLog(`✅ 已添加 Agent "${name}"（/agent ${name} 切换）`);
              break;
            }

            // 修改 Prompt：/agent edit <name> <prompt...>
            if (sub === "edit" || sub === "update" || sub === "set") {
              const name = parts[2];
              const prompt = parts.slice(3).join(" ").trim();
              if (!name || !prompt) {
                cliLog("用法: /agent edit <name> <prompt...>");
                break;
              }
              if (!agentRegistry.update(name, { prompt })) {
                cliLog(`❌ Agent "${name}" 不存在（/agents 查看）`);
                break;
              }
              saveAgentsToFile(agentRegistry.list());
              cliLog(`✅ 已更新 Agent "${name}" 的 Prompt`);
              // 编辑的是当前 agent → 立即热更新 system prompt
              if (name === agentRegistry.current) {
                engine.setSystemPrompt(
                  agentRegistry.buildSystemPrompt(
                    name,
                    WORKSPACE,
                    new Date().toISOString().split("T")[0]!,
                  ),
                );
                cliLog("  ↺ 当前 agent 的 Prompt 已热更新");
              }
              break;
            }

            // 删除 agent：/agent rm <name>
            if (sub === "rm" || sub === "remove" || sub === "del") {
              const name = parts[2];
              if (!name) {
                cliLog("用法: /agent rm <name>");
                break;
              }
              const wasCurrent = agentRegistry.current === name;
              if (!agentRegistry.remove(name)) {
                cliLog(`❌ Agent "${name}" 不存在（/agents 查看）`);
                break;
              }
              saveAgentsToFile(agentRegistry.list());
              cliLog(`✅ 已删除 Agent "${name}"`);
              if (wasCurrent) {
                const def = agentRegistry.currentDef;
                engine.setSystemPrompt(
                  agentRegistry.buildSystemPrompt(
                    def.name,
                    WORKSPACE,
                    new Date().toISOString().split("T")[0]!,
                  ),
                );
                cliLog(`  ↺ 当前 agent 已回退 → ${def.name}`);
              }
              break;
            }

            // 查看详情：/agent show [name]
            if (sub === "show" || sub === "info") {
              const name = parts[2] ?? agentRegistry.current;
              const def = agentRegistry.get(name);
              if (!def) {
                cliLog(`❌ Agent "${name}" 不存在（/agents 查看）`);
                break;
              }
              cliLog(
                `\n📄 Agent: ${def.name}${name === agentRegistry.current ? " (当前)" : ""}`,
              );
              if (def.description) cliLog(`  描述: ${def.description}`);
              cliLog(`  模型: ${def.model ?? "(沿用当前模型)"}`);
              cliLog("  Prompt:");
              cliLog(
                def.prompt
                  .split("\n")
                  .map((l) => `    ${l}`)
                  .join("\n"),
              );
              cliLog("");
              break;
            }

            // 其余视为切换：/agent <name>
            const def = agentRegistry.switch(sub);
            if (!def) {
              cliLog(
                `❌ Agent "${sub}" 不存在（/agents 查看，/agent add 添加）`,
              );
              break;
            }
            engine.setSystemPrompt(
              agentRegistry.buildSystemPrompt(
                def.name,
                WORKSPACE,
                new Date().toISOString().split("T")[0]!,
              ),
            );
            cliLog(`✅ 当前 agent → ${def.name}`);
            if (def.model && def.model !== engine.model) {
              engine.model = def.model;
              cliLog(`  ↺ 模型 → ${def.model}（随 agent 同步）`);
            }
            break;
          }

          case "/mcp": {
            const sub = (parts[1] ?? "").toLowerCase();
            const name = parts[2];

            // 无子命令 / list：列出全部 MCP 服务器
            if (!sub || sub === "list" || sub === "ls") {
              const configs = mcpManager!.listConfigs();
              const lazy = mcpManager!.isLazyActive();
              cliLog(
                `\n📡 MCP Servers (${configs.length} 个${lazy ? "，按需加载已启用" : ""}):`,
              );
              for (const cfg of configs) {
                const state = mcpManager!.isConnected(cfg.name)
                  ? "🟢 已连接"
                  : cfg.enabled === false
                    ? "⚪ 已禁用"
                    : "🔴 未连接";
                const total = mcpManager!.serverToolTotal(cfg.name);
                const loaded = mcpManager!.serverToolKeys(cfg.name).length;
                const tools =
                  lazy && total > 0
                    ? `工具×${loaded}/${total}`
                    : `工具×${loaded}`;
                const typeLabel =
                  cfg.type === "builtin"
                    ? `builtin:${cfg.builtin ?? cfg.name}`
                    : cfg.type;
                const target =
                  cfg.type === "stdio"
                    ? (cfg.command ?? []).join(" ")
                    : cfg.type === "builtin"
                      ? "进程内内置服务器"
                      : cfg.url;
                cliLog(
                  `  ${cfg.name} [${typeLabel}] ${state} ${tools}`,
                );
                cliLog(`    ${target}`);
              }
              if (configs.length === 0) {
                cliLog("  暂无配置（/mcp add 交互式安装）");
              }
              if (lazy) {
                cliLog(
                  "  ℹ️  工具较多：模型会先用 mcp_search_tools 检索，再按需加载",
                );
              }
              cliLog("");
              break;
            }

            // 添加：/mcp add <name> stdio <cmd...> | /mcp add <name> http <url>
            if (sub === "add") {
              // 无参数 → 交互式安装向导
              if (!name) {
                await mcpAddWizard();
                break;
              }
              const type = (parts[3] ?? "").toLowerCase();
              if (type !== "stdio" && type !== "http" && type !== "sse") {
                printMcpAddUsage();
                break;
              }
              const config: McpServerConfig =
                type === "stdio"
                  ? {
                      name,
                      type: "stdio",
                      command: parts.slice(4),
                      enabled: true,
                    }
                  : {
                      name,
                      type: type === "sse" ? "sse" : "http",
                      url: parts[4],
                      enabled: true,
                    };
              if (type === "stdio" && !(config.command ?? []).length) {
                cliLog("❌ 缺少启动命令");
                break;
              }
              if (type !== "stdio" && !config.url) {
                cliLog("❌ 缺少 URL");
                break;
              }
              try {
                await mcpManager!.addConfig(config);
                saveMcpConfigs();
                cliLog(
                  `✅ 已添加并连接 MCP server "${name}"（工具已注入）`,
                );
              } catch (err) {
                saveMcpConfigs(); // 配置先保存，稍后可重试连接
                cliLog(`⚠️  配置已保存，但连接失败: ${err}`);
                cliLog(`   可用 /mcp refresh ${name} 重试`);
              }
              break;
            }

            // 导入：/mcp import [file]
            if (sub === "import") {
              await mcpImportCommand(parts[2]);
              break;
            }

            // 移除：/mcp rm <name>
            if (sub === "rm" || sub === "remove" || sub === "del") {
              if (!name) {
                cliLog("用法: /mcp rm <name>");
                break;
              }
              const ok = await mcpManager!.removeConfig(name);
              if (!ok) {
                cliLog(`❌ MCP server "${name}" 不存在`);
                break;
              }
              saveMcpConfigs();
              cliLog(`✅ 已移除 MCP server "${name}"（工具已卸载）`);
              break;
            }

            // 启用/禁用：/mcp enable|disable <name>
            if (sub === "enable" || sub === "disable") {
              if (!name) {
                cliLog(`用法: /mcp ${sub} <name>`);
                break;
              }
              try {
                await mcpManager!.setEnabled(name, sub === "enable");
                saveMcpConfigs();
                cliLog(
                  `✅ 已${sub === "enable" ? "启用" : "禁用"} MCP server "${name}"`,
                );
              } catch (err) {
                cliLog(`❌ ${err}`);
              }
              break;
            }

            // 刷新工具列表：/mcp refresh [name]
            if (sub === "refresh") {
              const result = await mcpManager!.refresh(name);
              for (const n of result.connected) {
                cliLog(`✅ 已刷新 "${n}" 的工具列表`);
              }
              for (const f of result.failed) {
                cliLog(`❌ 刷新 "${f.name}" 失败: ${f.error}`);
              }
              if (result.connected.length === 0 && result.failed.length === 0) {
                cliLog("ℹ️  没有可刷新的服务器");
              }
              break;
            }

            cliLog(
              "用法: /mcp [list|add|import|rm|enable|disable|refresh]",
            );
            break;
          }

          case "/tools":
          case "/tool": {
            const sub = (parts[1] ?? "").toLowerCase();
            const registry = engine.registry;

            // 无子命令 / list：列出全部工具
            if (!sub || sub === "list" || sub === "ls") {
              const all = registry.list();
              const enabledCount = all.filter(
                (t) => !registry.isDisabled(t.name),
              ).length;
              cliLog(
                `\n🧰 Tools (${all.length} 个, 启用 ${enabledCount} 个):`,
              );
              for (const t of all) {
                const disabled = registry.isDisabled(t.name) ? " [已禁用]" : "";
                const src = t.source ? ` (${t.source})` : "";
                cliLog(
                  `  ${t.name}${disabled}${src} — ${t.metadata.category}/${t.metadata.riskLevel}`,
                );
              }
              cliLog("");
              break;
            }

            // 移除：/tool rm <name>
            if (sub === "rm" || sub === "remove" || sub === "del") {
              const name = parts[2];
              if (!name) {
                cliLog("用法: /tool rm <name>");
                break;
              }
              if (name.startsWith("mcp__")) {
                cliLog(
                  `ℹ️  ${name} 是 MCP 注入工具，请用 /mcp rm <server> 或 /mcp disable <server> 管理`,
                );
                break;
              }
              if (!registry.remove(name)) {
                cliLog(`❌ 工具 "${name}" 不存在（/tools 查看）`);
                break;
              }
              // 若移除的是命令工具，同步持久化
              const defs = loadCommandTools().filter((d) => d.name !== name);
              saveCommandTools(defs);
              cliLog(`✅ 已移除工具 "${name}"`);
              break;
            }

            // 禁用/启用：/tool disable|enable <name>
            if (sub === "disable" || sub === "enable") {
              const name = parts[2];
              if (!name) {
                cliLog(`用法: /tool ${sub} <name>`);
                break;
              }
              const ok =
                sub === "disable"
                  ? registry.disable(name)
                  : registry.enable(name);
              if (!ok) {
                cliLog(
                  `❌ 工具 "${name}" 不存在或状态未改变（/tools 查看）`,
                );
                break;
              }
              cliLog(
                `✅ 工具 "${name}" 已${sub === "disable" ? "禁用" : "启用"}`,
              );
              break;
            }

            // 添加命令工具：/tool add <name> <shell-command...>
            if (sub === "add" || sub === "new") {
              const name = parts[2];
              const command = parts.slice(3).join(" ").trim();
              if (!name || !command) {
                cliLog("用法: /tool add <name> <shell-command...>");
                break;
              }
              if (registry.has(name)) {
                cliLog(`❌ 工具 "${name}" 已存在（/tool rm 后重试）`);
                break;
              }
              const defs = [...loadCommandTools(), { name, command }];
              saveCommandTools(defs);
              registerCommandTools(registry, [{ name, command }]);
              cliLog(`✅ 已添加命令工具 "${name}" → ${command}`);
              break;
            }

            cliLog("用法: /tools | /tool [list|add|rm|disable|enable]");
            break;
          }

          case "/link": {
            const code = parts[1];
            const hub = parts[2] ?? process.env.HUB_URL;
            // 不带接入码：进入账号接入向导（Hub 地址 + 邮箱/手机号 + 密码/短信验证码）
            if (!code) {
              await runLinkCommand([], { rl, interactive: true });
              break;
            }
            if (!hub) {
              cliLog("用法: /link <注册码> [Hub地址]（Hub地址也可由 HUB_URL 环境变量提供）");
              break;
            }
            await runLinkCommand(["--hub", hub, "--code", code]);
            break;
          }

          case "/new":
          case "/clear":
            engine = buildEngine(SESSION_ID);
            resetSessionMeta();
            cliLog("✅ 会话已清空，引擎已重建\n");
            break;

          default:
            cliLog(`❌ 未知命令: ${name} (输入 /help 查看帮助)`);
            break;
        }
        continue;
      }

      const completed = await debugStageAsync("runTurn", () =>
        runTurn(engine, input),
      );

      // 任务成功完成 → 计数，并在第 1/3/5 次完成后后台自动生成会话名
      if (completed) {
        sessionMeta.taskCount += 1;
        saveEngineState(engine); // 及时持久化计数（同时增强 durable resume）
        if (shouldAutoName(sessionMeta.taskCount, sessionMeta.nameSource)) {
          void autoNameSession(engine, SESSION_ID);
        }
      }
    }
  } finally {
    // 优雅断开所有 MCP 子进程/HTTP 会话（防止进程挂起）
    await mcpManager?.closeAll();
    rl.close();
  }
}

main().catch((err: unknown) => {
  dlog("fatal", `main() 未捕获错误\n${describeError(err)}`);
  cliErr(err);
  // 启动/运行期的致命错误必须以非零码退出，否则脚本化调用会把失败当成功
  process.exitCode = 1;
});
