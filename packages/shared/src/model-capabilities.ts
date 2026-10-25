/**
 * 模型输入能力（文本 / 图片 / 音频 / 视频）
 *
 * 供应商的 `/models` 接口只给模型 id（少数给上下文长度），**不告诉客户端这个模型
 * 能不能看图、听音频**。因此能力由用户在「节点配置 → LLM」里为每个模型勾选，
 * 随 `modelMeta` 一起落盘：
 *
 *   - 后端在提交消息前据此校验附件类型（不支持的附件直接 400，而不是让供应商报错）；
 *   - 前端据此决定输入区可上传的文件类型（未勾选则不提供入口）。
 *
 * 纯数据 + 纯函数，供 core（服务端校验）与 console-ui（界面）共用。
 */

export const MODEL_CAPABILITIES = ["text", "image", "audio", "video"] as const;

/** 模型可接收的输入类型 */
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/** 非文本能力（对应可上传的附件种类） */
export type AttachmentCapability = Exclude<ModelCapability, "text">;

/** 能力的中文名（后端错误提示用；界面文案在前端 i18n 里） */
export const CAPABILITY_LABELS_ZH: Record<ModelCapability, string> = {
  text: "文本",
  image: "图片",
  audio: "音频",
  video: "视频",
};

/** 附件 MIME → 能力；非图片/音频/视频返回 null */
export function capabilityOfMime(mimeType: string): AttachmentCapability | null {
  const m = mimeType.trim().toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  return null;
}

/**
 * 规范化能力列表：丢弃未知值、去重、保持声明顺序。
 * 空数组/非法输入返回 undefined（表示「未配置」，由调用方按默认值处理）。
 */
export function normalizeCapabilities(v: unknown): ModelCapability[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ModelCapability[] = [];
  for (const x of v) {
    const s = String(x ?? "").trim().toLowerCase();
    if (!(MODEL_CAPABILITIES as readonly string[]).includes(s)) continue;
    const cap = s as ModelCapability;
    if (!out.includes(cap)) out.push(cap);
  }
  return out.length ? out : undefined;
}

/**
 * 取某个模型的输入能力。
 *
 * 匹配规则与上下文长度一致：精确 id 优先，其次前缀匹配（兼容 `-2024-08-06`
 * 这类日期后缀）。**未配置时只按文本处理**——多模态要显式勾选，避免把图片
 * 发给不支持视觉的模型后收到 400。
 */
export function capabilitiesOf(
  meta: { id: string; capabilities?: ModelCapability[] }[] | undefined,
  model: string,
): ModelCapability[] {
  if (!model || !meta?.length) return ["text"];
  const exact = meta.find((m) => m.id === model && m.capabilities?.length);
  if (exact?.capabilities?.length) return exact.capabilities;
  const prefix = meta.find((m) => m.capabilities?.length && model.startsWith(m.id));
  return prefix?.capabilities?.length ? prefix.capabilities : ["text"];
}

/** 该模型是否启用了某类附件输入 */
export function supportsCapability(
  meta: { id: string; capabilities?: ModelCapability[] }[] | undefined,
  model: string,
  capability: ModelCapability,
): boolean {
  return capabilitiesOf(meta, model).includes(capability);
}

/**
 * 已知支持视觉输入的模型（前缀匹配）。
 *
 * 供应商不返回能力信息，但让用户面对一个空勾选框、还要自己去查文档也不友好。
 * 「刷新模型」时用这张表给新模型一个合理的初始值（用户仍可在设置里改）：
 * 只列确定支持图片的公开模型；宁缺勿滥——错勾会把图发给纯文本模型并收到 400。
 */
const KNOWN_VISION_MODELS = [
  "deepseek-flash",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision",
  "gpt-4o",
  "gpt-4.1",
  "gpt-5",
  "o3",
  "o4-mini",
  "claude-3",
  "claude-4",
  "claude-sonnet",
  "claude-opus",
  "gemini-1.5",
  "gemini-2",
  "qwen-vl",
  "qwen2-vl",
  "qwen2.5-vl",
  "qwen3-vl",
  "glm-4v",
  "glm-4.5v",
  "moonshot-v1-vision",
  "kimi-vl",
];

/** 新模型的建议能力（未配置时的初始勾选）：已知视觉模型 → 文本 + 图片，其余仅文本 */
export function suggestedCapabilities(modelId: string): ModelCapability[] {
  const id = modelId.trim().toLowerCase();
  return KNOWN_VISION_MODELS.some((p) => id.startsWith(p)) ? ["text", "image"] : ["text"];
}
