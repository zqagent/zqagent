/**
 * Shell 沙箱（OS 级文件系统约束）
 *
 * 目标：让 `run_shell` 在工作区内可以免审批执行，而不是靠命令名白名单
 * 逐个放行——后者既挡不住 `python -c` 这类间接执行，也让日常开发寸步难行。
 *
 * 各平台取当前可用的最优方案：
 * - macOS：`/usr/bin/sandbox-exec`（SBPL profile）。系统自带，进程级，
 *   毫秒级开销；默认放行读与网络，只把 `file-write*` 收窄到工作区 + 临时目录。
 * - Linux：`bubblewrap`（bwrap）。用 `--ro-bind / /` 把整机只读挂载，
 *   再把工作区 `--bind` 成可写，二者叠加即为「只在工作区内可写」。
 *   需要发行版装了 bwrap 且允许非特权 user namespace（容器里通常需
 *   `--security-opt seccomp=unconfined` 或 privileged）。
 * - Windows：没有进程级文件系统沙箱的等价物（AppContainer 需要额外的
 *   原生 helper 与 ACL 配置，不属于零依赖方案）。此处明确返回
 *   `enforced: false`，由权限层退化为「工作区路径启发式」判定
 *   （见 permissions/workspaceGuard.ts）——它是降低打扰的策略，不是安全边界。
 *
 * 探测结果做进程级缓存：CLI 在 /mode、/agent 等场景会重建引擎，
 * 但沙箱能力不会变，不必每次 spawn 探测进程。
 */
import { spawnSync } from "node:child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** 沙箱后端 */
export type SandboxBackend = "sandbox-exec" | "bwrap" | "none";

/** 配置取值：auto=探测到就用；off=禁用；required=探测不到时明确报错 */
export type SandboxMode = "auto" | "off" | "required";

export interface SandboxOptions {
  mode?: SandboxMode;
  /** 额外可写路径（绝对路径，支持 ~；相对路径按 workspace 解析） */
  extraWritable?: string[];
  /** 工作区根（解析相对路径的额外可写项） */
  workspace?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fileExists?: (p: string) => boolean;
  /** 可用性探测（测试注入）；提供时不走缓存 */
  probe?: (backend: Exclude<SandboxBackend, "none">, bin: string) => boolean;
}

/** 沙箱方案（可跨调用复用） */
export interface SandboxPlan {
  backend: SandboxBackend;
  /** OS 级文件系统约束是否生效 */
  enforced: boolean;
  /** 沙箱可执行文件；未生效时为 null */
  bin: string | null;
  /** 允许写入的路径（绝对路径，已去重） */
  writable: string[];
  mode: SandboxMode;
  /** 状态说明（日志 / 工具描述用） */
  reason: string;
}

/** 一次待执行的子进程调用（file + argv，不经 shell 解释） */
export interface SandboxInvocation {
  file: string;
  argv: string[];
}

/** 解析 ~ 与环境变量无关的常见写法 */
function expandHome(p: string, env: NodeJS.ProcessEnv): string {
  if (p === "~") return env.HOME ?? p;
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(env.HOME ?? "~", p.slice(2));
  }
  return p;
}

/**
 * 工具链缓存目录：这些必须可写，否则 `pnpm install` / `npm ci` 会因
 * store / cache 落在工作区外而报 EPERM。只放行缓存与包仓库，
 * 不放行 `~/.ssh`、shell 配置等敏感位置。
 */
function toolchainWritable(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  const home = env.HOME ?? os.homedir();
  const rel =
    platform === "darwin"
      ? ["Library/pnpm", "Library/Caches", ".npm", ".cache"]
      : [".npm", ".cache", ".local/share/pnpm", ".local/state/pnpm", ".pnpm-store"];
  return rel.map((r) => path.join(home, r));
}

/**
 * 加入工具链缓存目录。
 *
 * 只加**真实存在**的目录：bwrap 对不存在的 bind 源会直接报错并终止整个命令
 * （`Can't find source path ~/.pnpm-store`），一个没装过的缓存目录就能让沙箱
 * 里所有命令失败。缓存目录不存在本身也无所谓——第一次 `pnpm install` 会自己建。
 */
function addToolchainWritable(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  add: (p: string) => void,
  exists: (p: string) => boolean,
): void {
  for (const dir of toolchainWritable(platform, env)) {
    if (exists(dir)) add(dir);
  }
}

/** 收集去重后的可写路径（工作区 + 临时目录 + 用户追加） */
function collectWritable(opts: {
  workspace: string;
  extraWritable: string[];
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** 路径存在性判定（测试可注入） */
  exists: (p: string) => boolean;
}): string[] {
  const out = new Set<string>();
  const add = (p: string): void => {
    if (!p) return;
    const abs = path.resolve(p);
    out.add(abs);
    // macOS 的 /tmp、/var 都是符号链接，SBPL 按真实路径匹配，两个都加上
    try {
      out.add(fs.realpathSync(abs));
    } catch {
      /* 路径尚不存在：只保留原始绝对路径 */
    }
  };

  add(opts.workspace);

  if (opts.platform === "darwin") {
    const tmp = os.tmpdir();
    add(tmp);
    add("/tmp");
    add("/private/tmp");
    add("/dev");
    addToolchainWritable(opts.platform, opts.env, add, opts.exists);
  } else if (opts.platform !== "win32") {
    add("/tmp");
    add("/dev");
    addToolchainWritable(opts.platform, opts.env, add, opts.exists);
  }

  for (const raw of opts.extraWritable) {
    const expanded = expandHome(String(raw ?? "").trim(), opts.env);
    if (!expanded) continue;
    add(path.resolve(opts.workspace, expanded));
  }

  return [...out];
}

/** 默认探测：真正跑一次最小命令，确认后端在本机可用（含 user namespace 限制） */
function defaultProbe(
  backend: Exclude<SandboxBackend, "none">,
  bin: string,
): boolean {
  const args =
    backend === "sandbox-exec"
      ? ["-p", "(version 1)(allow default)", "/bin/sh", "-c", "true"]
      : ["--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev", "--", "/bin/true"];
  try {
    const r = spawnSync(bin, args, { timeout: 3000, stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** 是否为正则化的模式取值 */
function normalizeMode(raw: string | undefined): SandboxMode {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "off" || v === "none" || v === "false") return "off";
  if (v === "required" || v === "on" || v === "true") return "required";
  return "auto";
}

/** 缓存键：同平台、同模式、同工作区、同追加路径只探测一次 */
const planCache = new Map<string, SandboxPlan>();

/**
 * 解析当前平台可用的沙箱方案。
 *
 * `mode: "off"` 直接返回未生效；`required` 在探测失败时通过 `reason`
 * 说明原因（调用方可据此拒绝启动或提示用户安装 bwrap）。
 */
export function resolveSandbox(opts: SandboxOptions = {}): SandboxPlan {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const workspace = path.resolve(opts.workspace ?? process.cwd());
  const mode = normalizeMode(opts.mode ?? env.ZQAGENT_SANDBOX);
  const extraWritable = opts.extraWritable ?? [];
  // 目录（而非文件）的存在性：缓存目录不存在时不能写进 bind 列表，
  // 否则 bwrap 会因为「源路径不存在」让整条命令失败。
  // 复用 fileExists 注入点，测试可用它模拟「目录都存在」。
  const pathExists: (p: string) => boolean =
    opts.fileExists ??
    ((p: string) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
  const writable = collectWritable({
    workspace,
    extraWritable,
    platform,
    env,
    exists: pathExists,
  });

  const cacheKey = [
    platform,
    mode,
    workspace,
    writable.join("\u0000"),
    opts.probe ? "injected" : "default",
  ].join("|");
  const cached = planCache.get(cacheKey);
  if (cached && !opts.probe) return cached;

  const finish = (plan: SandboxPlan): SandboxPlan => {
    if (!opts.probe) planCache.set(cacheKey, plan);
    return plan;
  };

  if (mode === "off") {
    return finish({
      backend: "none",
      enforced: false,
      bin: null,
      writable,
      mode,
      reason: "沙箱已按配置关闭",
    });
  }

  const fileExists = opts.fileExists ?? ((p: string) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });

  const candidate: { backend: Exclude<SandboxBackend, "none">; bin: string } | null =
    platform === "darwin"
      ? { backend: "sandbox-exec", bin: "/usr/bin/sandbox-exec" }
      : platform === "linux"
        ? { backend: "bwrap", bin: "/usr/bin/bwrap" }
        : null;

  if (!candidate) {
    return finish({
      backend: "none",
      enforced: false,
      bin: null,
      writable,
      mode,
      reason:
        platform === "win32"
          ? "Windows 无零依赖的进程级文件系统沙箱，改用工作区路径判定"
          : `平台 ${platform} 无受支持的沙箱后端`,
    });
  }

  if (!fileExists(candidate.bin)) {
    return finish({
      backend: "none",
      enforced: false,
      bin: null,
      writable,
      mode,
      reason: `未找到 ${candidate.bin}（${
        candidate.backend === "bwrap" ? "安装 bubblewrap 后可启用" : "系统缺少 sandbox-exec"
      }），改用工作区路径判定`,
    });
  }

  const probe = opts.probe ?? defaultProbe;
  if (!probe(candidate.backend, candidate.bin)) {
    return finish({
      backend: "none",
      enforced: false,
      bin: null,
      writable,
      mode,
      reason: `${candidate.bin} 探测失败（容器内可能禁用了 user namespace），改用工作区路径判定`,
    });
  }

  return finish({
    backend: candidate.backend,
    enforced: true,
    bin: candidate.bin,
    writable,
    mode,
    reason:
      candidate.backend === "sandbox-exec"
        ? "macOS sandbox-exec：只允许写入工作区与临时目录"
        : "Linux bubblewrap：只允许写入工作区与临时目录",
  });
}

/** SBPL 字符串字面量转义 */
function sbplString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * 生成 macOS sandbox profile。
 *
 * 采用「allow default + deny file-write* + 白名单放行」而不是
 * 「deny default」：后者要逐项放行进程、信号、sysctl、mach lookup 等，
 * 极易把 git / node / 包管理器弄挂，维护成本也高。这里只收窄写权限，
 * 读与网络保持默认——与 bwrap 方案的能力边界一致。
 */
export function buildMacProfile(writable: string[]): string {
  const rules = writable.map((p) => `  (subpath ${sbplString(p)})`).join("\n");
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    "(allow file-write*",
    rules,
    ")",
  ].join("\n");
}

/** 生成 bubblewrap 的参数前缀 */
export function buildBwrapArgs(writable: string[], cwd: string): string[] {
  const args: string[] = ["--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev"];
  // /tmp 用独立 tmpfs：避免把宿主机 /tmp 暴露成可写（工作区内的 /tmp 除外）
  if (!writable.includes("/tmp")) args.push("--tmpfs", "/tmp");
  for (const dir of writable) {
    if (dir === "/dev" || dir === "/proc") continue;
    args.push("--bind", dir, dir);
  }
  args.push("--chdir", cwd, "--die-with-parent");
  return args;
}

/**
 * 把一次 shell 调用包进沙箱。
 *
 * 未生效时原样返回（调用方无需分支）。参数一律走 argv，不拼字符串，
 * 避免用户命令中的引号 / 空格影响外层命令。
 */
export function wrapWithSandbox(
  plan: SandboxPlan | null | undefined,
  invocation: SandboxInvocation,
  ctx: { cwd: string },
): SandboxInvocation {
  if (!plan || !plan.enforced || !plan.bin) return invocation;

  if (plan.backend === "sandbox-exec") {
    return {
      file: plan.bin,
      argv: ["-p", buildMacProfile(plan.writable), invocation.file, ...invocation.argv],
    };
  }

  return {
    file: plan.bin,
    argv: [...buildBwrapArgs(plan.writable, ctx.cwd), "--", invocation.file, ...invocation.argv],
  };
}

/** 一行状态说明，用于日志与工具描述 */
export function describeSandbox(plan: SandboxPlan | null | undefined): string {
  if (!plan) return "未配置";
  return plan.enforced ? plan.reason : `未启用（${plan.reason}）`;
}

/** 测试用：清空探测缓存 */
export function resetSandboxCache(): void {
  planCache.clear();
}
