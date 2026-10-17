/**
 * 云端多租户 Server 入口（薄壳）
 *
 * 启动方式：`npm run server`（或 `tsx src/server/index.ts`）
 * 实际装配见 `./runtime.ts` 的 `startServer()`（与 CLI `zqagent serve` 共用同一实现）。
 *
 * 环境变量（未设置时自动读取项目根目录 .env，与 CLI 入口一致）：
 *   DATA_DIR          状态/租户根目录（默认 ./data）
 *   PORT              监听端口（默认 8787）
 *   HOST              监听地址（默认 127.0.0.1；云端部署设 0.0.0.0）
 *   APPROVAL_TIMEOUT_SECONDS  审批/提问挂起超时（默认 900，超时回收内存任务）
 *   TENANT_ID / TENANT_API_KEY / MODEL  首次启动自动创建的演示租户
 *   OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL  模型配置（演示租户）
 *   FLEET_TOKEN / FLEET_SECRET     节点签名命名空间/密钥（env 回退；fleet.json 优先）
 *   FLEET_GATEWAY_URL              Rust 网关地址（wss://…；凭据里下发了则以凭据为准）
 *   HUB_URL + HUB_ENROLL_CODE      首次启动凭注册码自动接入 Hub（也可用参数）
 *                                 未提供时，交互式终端会提示用 Hub 账号接入
 *   SECRET_KEY        凭据加密主密钥（64 位 hex，优先于 DATA_DIR/secret.key）
 *   QQ_BOT_APP_ID / QQ_BOT_APP_SECRET  QQ 官方机器人凭据；设置后启用 QQ 机器人
 *
 * 命令行参数（优先于同名环境变量）：
 *   --data-dir <dir>   --port <n>   --host <addr>
 *   --hub <url> --enroll-code <code> [--label <name>]   首次启动自动接入
 */
import "dotenv/config";
import { startServer } from "./runtime.js";
import { maybeAccountEnroll } from "../cli/account-enroll.js";

/** 读取 `--name value` 形式的命令行参数 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const hubUrl = (arg("hub") ?? process.env.HUB_URL ?? "").trim();
const enrollCode = (arg("enroll-code") ?? process.env.HUB_ENROLL_CODE ?? "").trim();
const label = arg("label")?.trim();

// 未带注册码的首次启动：交互式提示用 Hub 账号接入（已接入/非 TTY 时自动跳过）
void maybeAccountEnroll({ dataDir: arg("data-dir"), hubUrl: arg("hub"), label }).finally(() => {
  startServer({
    dataDir: arg("data-dir"),
    port: arg("port") ? Number(arg("port")) : undefined,
    host: arg("host"),
    // 仅当两者齐备时启用「启动即接入」；已有 fleet.json 时会在 runtime 内被忽略
    autoEnroll: hubUrl && enrollCode ? { hubUrl, code: enrollCode, label } : null,
    autoUpdate: true,
  });
});
