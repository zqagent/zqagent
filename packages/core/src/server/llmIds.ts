/**
 * 节点级 LLM 的固定 id 常量。
 *
 * 单独一个文件是为了避免循环依赖：`store.ts`（负责落盘兜底）与 `nodeLlm.ts`
 * （负责合并/校验）都要用这些 id，而 store 不适合反过来依赖 nodeLlm
 * （nodeLlm 依赖 session 的 ApiError，session 又依赖 store）。
 * 这里不引入任何其它模块。
 */

/** 环境变量配置的「节点全局 LLM」在列表中的固定 id（不可删除） */
export const GLOBAL_PROVIDER_ID = "__env__";

/**
 * 平台内置大模型（志前 API）的固定 id，接入 Hub 后自动下发。
 *
 * 与 `__env__` 的区别：`__env__` 是用户自己设 `OPENAI_API_KEY` 得来的；
 * 这个由控制面下发，Key 也由控制面托管，所以**用户不用关心 Key**。
 *
 * 三条约束（见 applyNodeLlmPatch / saveNodeLlm）：
 *   - 不能被删除（提交时过滤掉，保存时缺失则补回）
 *   - 不能改 baseURL / apiKey（防止把托管凭据指向别处）
 *   - 可以改 model / models / reasoningEffort（用户可换内置模型的具体型号）
 */
export const BUILTIN_PROVIDER_ID = "__zqai__";

/** 判断是否平台内置项 */
export function isBuiltinProvider(id: string | undefined | null): boolean {
  return id === BUILTIN_PROVIDER_ID;
}

/**
 * 完全没有配置线索时的兜底型号。
 *
 * **空串**：新装节点首次启动时还不知道会接哪家 API，此时任何具体型号都只是
 * 凭空猜测——早先写死过 `deepseek-v4-flash`（志前 API 不认，首次请求 404），
 * 后来换成 `gpt-4o` 同样有问题：控制台的模型下拉里会平白多出一个用户从未
 * 配置过、也没有对应 Key 的「默认模型」，看上去像是系统替他选好了，实际一发
 * 请求就报错。
 *
 * 没有配置就不假装有：等内置模型下发（见 builtinLlm）或用户自己添加供应商后，
 * `defaultTenantModel` 会取到真实可用的型号。
 *
 * 放在这里（而非 nodeLlm.ts）是为了让 builtinLlm 能直接引用而不形成
 * builtinLlm → nodeLlm → session → builtinLlm 的环。
 */
export const FALLBACK_MODEL = "";

/**
 * 历史上被当过「系统默认」的型号：
 *
 * - `""`：当前兜底值（没有任何配置线索）；
 * - `gpt-4o`：上一版兜底值，老节点磁盘上可能还留着一批租户停在这个型号上；
 * - `deepseek-v4-flash`：更早的演示租户硬编码值，志前 API 只认 `deepseek-flash`。
 *
 * 内置模型下发后，停在这些值上的租户会被对齐到真实型号（见 builtinLlm 的
 * adoptBuiltinModelForTenants），用户自己选过的型号不动。
 */
export const LEGACY_DEFAULT_MODELS: readonly string[] = [
  FALLBACK_MODEL,
  "gpt-4o",
  "deepseek-v4-flash",
];
