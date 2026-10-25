/**
 * 节点宿主信息（CPU / 内存 / 网络 / 存储 / 运行版本 / 概览统计）
 *
 * 供控制台节点详情弹窗使用（REST GET /api/v1/node/host 与指令 get_node_host）。
 * 概览统计（项目/会话/运行/等待/token）由各项目 projectStats 汇总而来。
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import type { Store } from "./store.js";
import type { SessionManager } from "./session.js";
import { projectStats } from "./projectStats.js";

export interface NodeHostSession {
  projectId: string;
  projectName: string;
  sessionId: string;
  name: string | null;
  status: string;
}

export interface NodeHostDisk {
  /** 挂载点（Windows 为盘符根，如 C:\） */
  path: string;
  total: number;
  free: number;
}

export interface NodeHost {
  nodeId: string;
  hostname: string;
  platform: string;
  arch: string;
  release: string;
  uptimeSec: number;
  version: string;
  mode: string;
  cpu: { count: number; model: string; loadAvg: number[] };
  memory: { total: number; free: number };
  network: Array<{ name: string; address: string; family: string; internal: boolean }>;
  disk: NodeHostDisk | null;
  /** 本机全部存储（按容量倒序）：工作目录所在盘 + 其它挂载点 */
  disks: NodeHostDisk[];
  /** 概览统计 */
  projects: number;
  sessions: { total: number; running: number; waiting: number; items: NodeHostSession[] };
  usage: { tokensIn: number; tokensOut: number };
}

function diskInfo(pathStr: string): NodeHostDisk | null {
  try {
    const st = fs.statfsSync(pathStr);
    return {
      path: pathStr,
      total: Number(st.blocks) * Number(st.bsize),
      free: Number(st.bavail) * Number(st.bsize),
    };
  } catch {
    return null;
  }
}

/** 虚拟文件系统：df 里出现但并不是「存储」，列出来只会干扰判断 */
const PSEUDO_FS =
  /^(devfs|tmpfs|devtmpfs|proc|procfs|sysfs|none|udev|shm|mqueue|devpts|hugetlbfs|debugfs|tracefs|securityfs|pstore|bpf|configfs|fusectl|nsfs|autofs|efivarfs|ramfs|map)$/;

/**
 * 系统内部挂载点：对用户没有意义，不列入存储列表。
 * macOS 的 /System/Volumes/*（Preboot/VM/Update/Data 都与根卷同源）排在 / 之后会和根卷重复；
 * Linux 的 /snap/* 是只读 squashfs 镜像，不是可用存储。
 */
function isInternalMount(mount: string): boolean {
  if (mount === "/") return false;
  const prefixes = ["/proc", "/sys", "/run", "/snap"];
  if (process.platform === "darwin") prefixes.push("/System/Volumes");
  return prefixes.some((p) => mount === p || mount.startsWith(`${p}/`));
}

/**
 * macOS 上只读挂载的卷（多为打开过的 .dmg 安装盘）：读不出可用空间的意义，
 * 列出来只会把真正的磁盘挤出视野。根卷同样是 sealed 只读，需保留。
 */
function readOnlyVolumes(): Set<string> {
  const out = new Set<string>();
  const res = spawnSync("mount", [], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  if (res.error || res.status !== 0 || !res.stdout) return out;
  for (const line of res.stdout.split("\n")) {
    const m = line.match(/^.+? on (.+?) \(([^)]*)\)$/);
    if (!m || m[1] === "/") continue;
    if (m[2].split(",").some((opt) => opt.trim() === "read-only")) out.add(m[1]);
  }
  return out;
}

/**
 * 列出本机的全部存储（挂载点）。
 *
 * - Linux / macOS：`df -kP`（POSIX 输出，一行一个文件系统），过滤掉虚拟文件系统；
 * - Windows：没有 df，逐个盘符 statfs，存在的即为一个存储；
 * - 枚举不到时退回工作目录所在盘的单一结果，保证详情页至少有当前盘。
 */
function diskList(workspacePath: string): NodeHostDisk[] {
  const out: NodeHostDisk[] = [];
  const seen = new Set<string>();
  const push = (path: string, total: number, free: number) => {
    if (!path || seen.has(path) || !Number.isFinite(total) || total <= 0) return;
    seen.add(path);
    out.push({ path, total, free });
  };

  if (process.platform === "win32") {
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
      const root = `${letter}:\\`;
      const d = diskInfo(root);
      if (d) push(root, d.total, d.free);
    }
  } else {
    const readonly = process.platform === "darwin" ? readOnlyVolumes() : new Set<string>();
    const res = spawnSync("df", ["-kP"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!res.error && res.status === 0 && res.stdout) {
      for (const line of res.stdout.split("\n").slice(1)) {
        // 设备 总块数 已用 可用 使用率% 挂载点（挂载点允许含空格，放最后）
        const m = line.trim().match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/);
        if (!m || PSEUDO_FS.test(m[1])) continue;
        // 只读镜像设备（snap / loop 挂载）不是可用存储
        if (/^\/dev\/loop\d+$/.test(m[1])) continue;
        if (isInternalMount(m[5]) || readonly.has(m[5])) continue;
        // df -k：块大小 1KiB；可用取 bavail 口径，与 statfsSync 一致
        push(m[5], Number(m[2]) * 1024, Number(m[4]) * 1024);
      }
    }
  }

  // 工作目录所在盘：已在上面的挂载点里（同一块盘）时不再重复列一行
  const primary = diskInfo(workspacePath);
  if (primary) {
    const covered = out.some((d) => {
      const root = d.path.endsWith("/") || d.path.endsWith("\\") ? d.path : `${d.path}/`;
      return workspacePath === d.path || workspacePath.startsWith(root);
    });
    if (!covered) push(primary.path, primary.total, primary.free);
  }

  return out.sort((a, b) => b.total - a.total);
}

function networkInfo(): NodeHost["network"] {
  const out: NodeHost["network"] = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const info of list ?? []) {
      out.push({
        name,
        address: info.address,
        family: String(info.family),
        internal: info.internal,
      });
    }
  }
  return out;
}

/** 汇总全部项目的概览统计（项目/会话/运行/等待/token + 运行等待会话清单） */
function overview(store: Store, manager: SessionManager): Pick<NodeHost, "projects" | "sessions" | "usage"> {
  const items: NodeHostSession[] = [];
  let projects = 0;
  let total = 0;
  let running = 0;
  let waiting = 0;
  let tokensIn = 0;
  let tokensOut = 0;

  for (const id of store.listTenants()) {
    const t = store.loadTenant(id);
    if (!t) continue;
    projects += 1;
    let st: ReturnType<typeof projectStats>;
    try {
      st = projectStats(manager, t.id);
    } catch {
      continue;
    }
    total += st.sessionCount;
    running += st.running;
    waiting += st.waiting;
    tokensIn += st.tokensIn;
    tokensOut += st.tokensOut;
    for (const s of st.sessions) {
      if (
        s.status === "running" ||
        s.status === "waiting_approval" ||
        s.status === "waiting_question"
      ) {
        items.push({
          projectId: t.id,
          projectName: t.name ?? t.id,
          sessionId: s.sessionId,
          name: s.name,
          status: s.status,
        });
      }
    }
  }

  return { projects, sessions: { total, running, waiting, items }, usage: { tokensIn, tokensOut } };
}

export function buildNodeHost(store: Store, manager: SessionManager, diskPath?: string): NodeHost {
  const cpus = os.cpus();
  const ov = overview(store, manager);
  const disks = diskList(diskPath || process.cwd());
  return {
    nodeId: store.loadNodeId() ?? "",
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    uptimeSec: Math.round(os.uptime()),
    version: process.env.ZQAGENT_VERSION ?? "dev",
    mode: process.env.NODE_MODE ?? "standalone",
    cpu: {
      count: cpus.length,
      model: cpus[0]?.model ?? "",
      loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    },
    memory: { total: os.totalmem(), free: os.freemem() },
    network: networkInfo(),
    disk: diskInfo(diskPath || process.cwd()),
    disks,
    ...ov,
  };
}
