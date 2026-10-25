/**
 * LLM 供应商预设（CLI `/connect` 与 Web/桌面「节点配置」共用的唯一来源）
 *
 * 纯数据模块：不依赖 Node API，前端（console-ui）与后端（core）都可直接引用，
 * 保证两端「添加供应商」时看到完全一致的预置列表。
 *
 * `id` 会持久化为配置项的 `type` 字段（历史字段名，仅展示用途）。
 */

export interface LlmPreset {
  /** 稳定标识（持久化为 provider.type） */
  id: string;
  /** 展示名 */
  name: string;
  /** OpenAI 兼容端点；空串表示需用户自行填写 */
  baseURL: string;
  /** 建议默认模型；空串表示需要刷新模型列表后由用户选择 */
  model: string;
  /** 是否支持推理强度（reasoning effort）设置 */
  supportsReasoningEffort: boolean;
  /** 选择列表中的补充说明 */
  hint?: string;
}

/** 预置供应商（顺序即界面展示顺序） */
export const LLM_PRESETS: readonly LlmPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    // 不预填模型：预填等于替用户拍板一个他既没选过、也可能没有权限的型号，
    // 之后控制台的模型下拉就凭空多出这个「系统默认模型」。填完 Key 刷新模型，
    // 由供应商实际返回的列表来选。
    model: "",
    supportsReasoningEffort: true,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-flash",
    supportsReasoningEffort: false,
    hint: "deepseek-flash = 通用对话, deepseek-reasoner = 深度推理",
  },
  {
    id: "qwen",
    name: "通义千问",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    supportsReasoningEffort: false,
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-plus",
    supportsReasoningEffort: false,
  },
  {
    id: "moonshot",
    name: "月之暗面 Kimi",
    baseURL: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
    supportsReasoningEffort: false,
  },
  {
    id: "xiaomi",
    name: "小米 MiMo",
    baseURL: "",
    model: "",
    supportsReasoningEffort: false,
    hint: "需自行填写端点与模型",
  },
  {
    id: "custom",
    name: "其它 (OpenAI 兼容)",
    baseURL: "",
    model: "",
    supportsReasoningEffort: true,
    hint: "任意兼容 OpenAI API 的服务端点（如本地 vLLM 等）",
  },
];

/** 按 id 取预设；未命中返回 undefined */
export function llmPreset(id: string): LlmPreset | undefined {
  return LLM_PRESETS.find((p) => p.id === id);
}
