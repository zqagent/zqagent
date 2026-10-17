/**
 * 节点宿主信息（CPU / 内存 / 网络 / 存储 / 运行版本 / 概览统计）
 *
 * 供控制台节点详情弹窗使用（REST GET /api/v1/node/host 与指令 get_node_host）。
 * 概览统计（项目/会话/运行/等待/token）由各项目 projectStats 汇总而来。
 */
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
  disk: { path: string; total: number; free: number } | null;
  /** 概览统计 */
  projects: number;
  sessions: { total: number; running: number; waiting: number; items: NodeHostSession[] };
  usage: { tokensIn: number; tokensOut: number };
}

function diskInfo(pathStr: string): NodeHost["disk"] {
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
    ...ov,
  };
}
