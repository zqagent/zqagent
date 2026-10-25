/**
 * Agent 注册表（AgentRegistry）
 *
 * 负责在运行时管理多个 agent 的定义：名称、描述、系统提示词（Prompt）、
 * 可选模型。支持增删改查与当前 agent 切换，并可按任意 agent 组装
 * 完整系统提示词（agent prompt + 叙述规则 + 环境信息）。
 *
 * 本类只做内存管理，不负责持久化——持久化（如写入 agents.json）
 * 由调用方（如 CLI）自行实现。
 */

import {
  CODE_INSTRUCTIONS,
  COWORK_INSTRUCTIONS,
  LANGUAGE_GUIDANCE,
  MCP_GUIDANCE,
  NARRATION_GUIDANCE,
  OCR_GUIDANCE,
  buildEnvBlock,
} from "../prompts/index.js";

/** 单个 Agent 的定义 */
export interface AgentDef {
  /** agent 名称（唯一标识，切换 / 增删改查均以它为键） */
  name: string;
  /** 一句话描述（展示用，可选） */
  description?: string;
  /** 系统提示词（Prompt），即该 agent 的「人设 + 行为规则」 */
  prompt: string;
  /**
   * 可选：切换到此 agent 时同步切换的模型标识
   * （如 "your-model"）。未设置则沿用当前模型。
   */
  model?: string;
}

/** 内置默认 agent：code=编程助手 / cowork=通用协作助手 */
export const BUILTIN_AGENTS: AgentDef[] = [
  { name: "code", description: "编程助手（默认）", prompt: CODE_INSTRUCTIONS },
  { name: "cowork", description: "通用协作助手", prompt: COWORK_INSTRUCTIONS },
];

/** 默认当前 agent 名称（内置 code 存在时优先） */
function defaultCurrent(defs: AgentDef[]): string {
  if (defs.some((d) => d.name === "code")) return "code";
  return defs[0]?.name ?? "";
}

export class AgentRegistry {
  private _agents = new Map<string, AgentDef>();
  private _current: string;

  /**
   * @param defs 初始 agent 定义列表（缺省为内置 code / cowork）。
   *             同名定义后者覆盖前者（可用于用磁盘配置覆盖内置 prompt）。
   */
  constructor(defs: AgentDef[] = BUILTIN_AGENTS) {
    for (const d of defs) this._agents.set(d.name, { ...d });
    this._current = defaultCurrent(defs);
  }

  /** 当前 agent 名称 */
  get current(): string {
    return this._current;
  }

  /** 当前 agent 定义 */
  get currentDef(): AgentDef {
    return this.get(this._current)!;
  }

  /** 全部 agent 定义（按注册顺序，返回副本，外部修改不影响内部） */
  list(): AgentDef[] {
    return [...this._agents.values()].map((d) => ({ ...d }));
  }

  /** 按名称取 agent 定义，不存在返回 undefined（返回副本） */
  get(name: string): AgentDef | undefined {
    const d = this._agents.get(name);
    return d ? { ...d } : undefined;
  }

  /** 是否存在指定名称的 agent */
  has(name: string): boolean {
    return this._agents.has(name);
  }

  /**
   * 新增 agent。同名已存在时抛错（修改请用 update / set）。
   */
  add(def: AgentDef): void {
    if (this._agents.has(def.name)) {
      throw new Error(`Agent "${def.name}" 已存在`);
    }
    this._agents.set(def.name, { ...def });
  }

  /**
   * 写入 agent（upsert 语义）：同名存在则整体覆盖，否则新增。
   * 常用于从持久化文件加载或整体替换 prompt。
   */
  set(def: AgentDef): void {
    this._agents.set(def.name, { ...def });
  }

  /**
   * 局部修改 agent（如只改 prompt 或 model）。
   * @returns 是否修改成功（名称不存在返回 false）
   */
  update(name: string, patch: Partial<Omit<AgentDef, "name">>): boolean {
    const cur = this._agents.get(name);
    if (!cur) return false;
    this._agents.set(name, { ...cur, ...patch });
    return true;
  }

  /**
   * 删除 agent。若删除的是当前 agent，回退到 code（不存在则回退到
   * 剩余的第一个，空则置空字符串）。
   * @returns 是否删除成功（名称不存在返回 false）
   */
  remove(name: string): boolean {
    if (!this._agents.has(name)) return false;
    this._agents.delete(name);
    if (this._current === name) {
      const rest = [...this._agents.keys()];
      this._current = rest.includes("code") ? "code" : (rest[0] ?? "");
    }
    return true;
  }

  /**
   * 切换当前 agent。
   * @returns 切换后的 agent 定义（可用于同步模型，返回副本），
   *          名称不存在返回 undefined
   */
  switch(name: string): AgentDef | undefined {
    const def = this._agents.get(name);
    if (!def) return undefined;
    this._current = name;
    return { ...def };
  }

  /**
   * 为指定 agent 组装完整系统提示词：
   * agent prompt + 叙述规则 + MCP/OCR/语言引导 + 环境信息块。
   *
   * @param name      agent 名称（不存在时回退到当前 agent）
   * @param workspace 工作区路径（注入环境信息块）
   * @param today     当前日期（ISO 格式，注入环境信息块）
   */
  buildSystemPrompt(name: string, workspace: string, today: string): string {
    const def = this.get(name) ?? this.currentDef;
    return [
      def.prompt,
      NARRATION_GUIDANCE,
      MCP_GUIDANCE,
      OCR_GUIDANCE,
      LANGUAGE_GUIDANCE,
      buildEnvBlock(workspace, today),
    ].join("\n\n");
  }
}
