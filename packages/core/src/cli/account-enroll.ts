/**
 * 节点首次启动的「账号接入」交互向导
 *
 * 本地尚未接入（无 `fleet.json`、环境变量也没给凭据）且处于 TTY 时，提示输入
 * Hub 地址与账号：邮箱/手机号 + 密码，或手机号 + 短信验证码。校验通过后 Hub
 * 为该账号签发节点凭据（节点默认归入「未分组」），本模块把它落盘 `fleet.json`，
 * 随后 `startServer` 会自动连上 Hub 网关。
 *
 * 非 TTY（systemd / docker / 管道）一律跳过，不阻塞启动；直接回车采用默认 Hub
 * 地址（`--hub` / `HUB_URL` / 内置官方地址），输入 `-` 跳过、保持纯本地。
 */
import * as path from "path";
import * as readline from "node:readline/promises";
import { Store } from "../server/store.js";
import { ensureNodeId } from "../server/projects.js";
import { resolveFleetConfig } from "../server/fleet-config.js";
import { DEFAULT_DATA_DIR, DEFAULT_HUB_URL } from "../paths.js";
import { defaultNodeLabel } from "../node-name.js";
import { cliErr, cliLog, cliWrite } from "../terminal.js";
import { hubEnrollByAccount, hubSendSms } from "@zqagent/shared/hub-api";

/**
 * 向导所需的最小 readline 接口。
 *
 * `readline/promises` 与 `readline` 的 Interface 类型不同（前者 question 返回
 * Promise）；这里只依赖实际用到的三个方法，便于 `zqagent link` 复用交互 CLI
 * 里已经打开的 readline，避免同时挂两个输入接口导致字符回显两次。
 */
export interface PromptInterface {
  question(query: string): Promise<string>;
  pause(): void;
  resume(): void;
}

/** 交互式向导收集到的登录凭据（与 Hub `/enroll/account` 的字段一致） */
export interface AccountLoginInput {
  email?: string;
  phone?: string;
  password?: string;
  /** 短信验证码 */
  code?: string;
}

export interface AccountEnrollOptions {
  dataDir?: string;
  /** 默认 Hub 地址（取自 --hub / HUB_URL）；用户可直接回车采用 */
  hubUrl?: string;
  label?: string;
}

/** 向导里表示「不接入」的回答（直接回车则采用默认 Hub 地址） */
const SKIP_ANSWERS = new Set(["-", "skip", "none", "no"]);

/** 默认 Hub 基址：`--hub` → `HUB_URL` → 内置官方地址（去结尾斜杠） */
export function resolveDefaultHub(
  hubUrl?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (hubUrl ?? env.HUB_URL ?? DEFAULT_HUB_URL).trim().replace(/\/$/, "");
}

/**
 * 解析 Hub 地址回答：空串采用默认值，`-`/skip/none 返回 null 表示跳过接入。
 */
export function parseHubAnswer(answer: string, fallback: string): string | null {
  const a = answer.trim();
  if (SKIP_ANSWERS.has(a.toLowerCase())) return null;
  return (a || fallback).replace(/\/$/, "");
}

/** 交互式读取 Hub 地址；返回 null 表示用户跳过接入 */
export async function promptHubUrl(
  rl: PromptInterface,
  hubUrl?: string,
): Promise<string | null> {
  const fallback = resolveDefaultHub(hubUrl);
  const answer = await rl.question(`Hub 地址 [${fallback}]：`);
  return parseHubAnswer(answer, fallback);
}

/**
 * 交互式读取登录凭据（邮箱/手机号 + 密码，或手机号 + 短信验证码）。
 * 返回 null 表示输入不完整或用户放弃。
 */
export async function promptAccountLogin(
  rl: PromptInterface,
  hubUrl?: string,
): Promise<AccountLoginInput | null> {
  cliLog("登录方式：1) 邮箱 + 密码   2) 手机号 + 密码   3) 手机号 + 短信验证码");
  const mode = (await rl.question("请选择 [1]：")).trim() || "1";

  const input: AccountLoginInput = {};
  if (mode === "1") {
    input.email = (await rl.question("邮箱：")).trim();
    input.password = await askHidden(rl, "密码：");
    if (!input.email || !input.password) {
      cliErr("邮箱与密码不能为空，已跳过接入。");
      return null;
    }
  } else if (mode === "2") {
    input.phone = (await rl.question("手机号：")).trim();
    input.password = await askHidden(rl, "密码：");
    if (!input.phone || !input.password) {
      cliErr("手机号与密码不能为空，已跳过接入。");
      return null;
    }
  } else if (mode === "3") {
    input.phone = (await rl.question("手机号：")).trim();
    if (!input.phone) {
      cliErr("手机号不能为空，已跳过接入。");
      return null;
    }
    try {
      const sent = await hubSendSms(resolveDefaultHub(hubUrl), {
        phone: input.phone,
        purpose: "login",
      });
      if (sent.debugCode) cliLog(`（调试模式验证码：${sent.debugCode}）`);
      else cliLog("验证码已发送，5 分钟内有效。");
    } catch (e) {
      // 短信登录超限 / 需要图形验证码 / 未配置短信服务：HTTPS 端无从补全
      cliErr(`短信验证码发送失败：${e instanceof Error ? e.message : String(e)}`);
      cliLog("  可改用方式 1/2（密码登录），或在网页端生成接入码后执行：");
      cliLog("    zqagent link --hub <Hub地址> --code <接入码>");
      return null;
    }
    input.code = (await rl.question("短信验证码：")).trim();
    if (!input.code) {
      cliErr("验证码不能为空，已跳过接入。");
      return null;
    }
  } else {
    cliErr("未知的登录方式，已跳过接入。");
    return null;
  }
  return input;
}

/**
 * 完整的接入向导：Hub 地址 + 登录凭据。
 *
 * `askHub: false` 用于安装脚本等已经确定 Hub 地址的场景（只问账号密码）。
 * 返回 null 表示用户跳过或输入不完整。
 */
export async function promptLinkAccount(
  rl: PromptInterface,
  hubUrl?: string,
  opts: { askHub?: boolean } = {},
): Promise<{ hubUrl: string; auth: AccountLoginInput } | null> {
  const fallback = resolveDefaultHub(hubUrl);
  let resolved = fallback;
  if (opts.askHub !== false) {
    const answer = await promptHubUrl(rl, fallback);
    if (!answer) {
      cliLog("已跳过接入：节点保持纯本地运行。");
      return null;
    }
    resolved = answer;
  }
  const auth = await promptAccountLogin(rl, resolved);
  if (!auth) return null;
  return { hubUrl: resolved, auth };
}

/** 隐藏输入（供 `zqagent link --username` 缺密码时补问） */
export async function promptPassword(
  rl: PromptInterface,
  prompt = "密码：",
): Promise<string> {
  return askHidden(rl, prompt);
}

/** 解析数据目录（与 startServer 同一规则） */
function resolveDataDir(dataDir?: string): string {
  return path.resolve(dataDir ?? process.env.DATA_DIR ?? DEFAULT_DATA_DIR);
}

/**
 * 首次启动的账号接入向导（幂等）：已接入或非 TTY 时直接返回。
 *
 * 失败只打印原因、不抛出——接入不了不应影响本地功能。
 */
export async function maybeAccountEnroll(opts: AccountEnrollOptions = {}): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return; // 非交互环境跳过

  let store: Store;
  try {
    store = new Store(resolveDataDir(opts.dataDir));
    if (resolveFleetConfig(store)) return; // 已接入：fleet.json / 环境变量
  } catch (e) {
    cliErr(`接入检查失败：${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await runWizard(rl, store, opts);
  } catch (e) {
    cliErr(`接入失败：${e instanceof Error ? e.message : String(e)}`);
    cliLog("  可稍后在控制台生成接入码，再执行：zqagent link --hub <Hub地址> --code <接入码>");
  } finally {
    rl.close();
  }
}

async function runWizard(
  rl: PromptInterface,
  store: Store,
  opts: AccountEnrollOptions,
): Promise<void> {
  cliLog("");
  cliLog("本机尚未接入 Hub。可用 Hub 账号接入（节点默认进入「未分组」）；输入 - 跳过保持纯本地。");

  const prompted = await promptLinkAccount(rl, opts.hubUrl);
  if (!prompted) return;

  const nodeId = ensureNodeId(store);
  // 未指定名称时用主机名，与 link / serve 的默认一致
  const label = opts.label?.trim() || defaultNodeLabel();
  const cred = await hubEnrollByAccount(prompted.hubUrl, {
    ...prompted.auth,
    nodeId,
    label,
  });
  store.saveFleetCredential({
    ...cred,
    label,
    enrolledAt: new Date().toISOString(),
  });
  // 节点上报的 label 取自 node.json，与 Hub 记录保持一致
  store.saveNodeLabel(label);
  cliLog(`✅ 已接入 Hub：节点 ${cred.nodeId}（网关 ${cred.gatewayUrl ?? "未下发"}）`);
  cliLog("   凭据已保存到 fleet.json，本次启动即连接 Hub。");
}

/** 隐藏输入（密码不回显，以 * 占位）；非 TTY 退化为普通输入 */
async function askHidden(rl: PromptInterface, prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return (await rl.question(prompt)).trim();

  return new Promise<string>((resolve) => {
    // 与 CLI 主循环同款做法：读取期间摘掉 readline 挂在 stdin 上的 data 监听，
    // 否则每个字符会被「明文 + *」各回显一次。
    const saved = process.stdin.listeners("data");
    process.stdin.removeAllListeners("data");
    cliWrite(prompt);
    rl.pause();
    process.stdin.setRawMode(true);
    process.stdin.resume();

    let buf = "";
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      for (const listener of saved) {
        process.stdin.on("data", listener as (chunk: Buffer) => void);
      }
      process.stdin.setRawMode(true);
      rl.resume();
    };
    const onData = (chunk: Buffer) => {
      // 剥掉方向键等 ANSI 转义序列
      const s = chunk
        .toString()
        .replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, "")
        .replace(/\x1bO[A-Za-z]/g, "");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          cliWrite("\n");
          resolve(buf);
          return;
        }
        if (ch === "\x03") {
          // Ctrl+C：按空密码处理，由上层判定为「跳过接入」
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
    process.stdin.on("data", onData);
  });
}
