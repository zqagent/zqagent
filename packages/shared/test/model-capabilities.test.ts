/** 模型输入能力与供应商预设。 */
import { describe, it, expect } from "vitest";
import { LLM_PRESETS, llmPreset } from "../src/llm-presets.js";
import {
  MODEL_CAPABILITIES,
  capabilityOfMime,
  capabilitiesOf,
  normalizeCapabilities,
  suggestedCapabilities,
  supportsCapability,
} from "../src/model-capabilities.js";

describe("capabilityOfMime", () => {
  it("按前缀映射图片/音频/视频（大小写与空白不敏感）", () => {
    expect(capabilityOfMime("image/png")).toBe("image");
    expect(capabilityOfMime(" IMAGE/JPEG ")).toBe("image");
    expect(capabilityOfMime("audio/mpeg")).toBe("audio");
    expect(capabilityOfMime("video/mp4")).toBe("video");
  });

  it("其它类型返回 null", () => {
    expect(capabilityOfMime("text/plain")).toBeNull();
    expect(capabilityOfMime("application/pdf")).toBeNull();
    expect(capabilityOfMime("")).toBeNull();
  });
});

describe("normalizeCapabilities", () => {
  it("保留已知能力、去重、按声明顺序", () => {
    expect(normalizeCapabilities(["image", "text", "image"])).toEqual(["image", "text"]);
    expect(normalizeCapabilities(["IMAGE", " audio "])).toEqual(["image", "audio"]);
  });

  it("非数组/空/全非法返回 undefined", () => {
    expect(normalizeCapabilities(undefined)).toBeUndefined();
    expect(normalizeCapabilities("image")).toBeUndefined();
    expect(normalizeCapabilities([])).toBeUndefined();
    expect(normalizeCapabilities(["bogus", null, 1])).toBeUndefined();
  });
});

describe("capabilitiesOf / supportsCapability", () => {
  const meta = [
    { id: "gpt-4o", capabilities: ["text", "image"] as const },
    { id: "gpt-4o-2024", capabilities: ["text"] as const },
    { id: "claude-3", capabilities: ["text", "image", "audio"] as const },
  ];

  it("精确匹配优先于前缀匹配", () => {
    expect(capabilitiesOf([...meta], "gpt-4o")).toEqual(["text", "image"]);
    expect(capabilitiesOf([...meta], "gpt-4o-2024-08-06")).toEqual(["text", "image"]);
  });

  it("未配置时只返回 text", () => {
    expect(capabilitiesOf(undefined, "x")).toEqual(["text"]);
    expect(capabilitiesOf([], "x")).toEqual(["text"]);
    expect(capabilitiesOf([{ id: "x" }], "x")).toEqual(["text"]);
    expect(capabilitiesOf([{ id: "x" }], "")).toEqual(["text"]);
  });

  it("supportsCapability 按能力判断", () => {
    expect(supportsCapability([...meta], "claude-3-5", "audio")).toBe(true);
    expect(supportsCapability([...meta], "claude-3-5", "video")).toBe(false);
    expect(supportsCapability(undefined, "claude-3", "text")).toBe(true);
    expect(supportsCapability(undefined, "claude-3", "image")).toBe(false);
  });
});

describe("suggestedCapabilities", () => {
  it("已知视觉模型默认文本+图片", () => {
    expect(suggestedCapabilities("gpt-4o-mini")).toEqual(["text", "image"]);
    expect(suggestedCapabilities(" Qwen2.5-VL-72B ")).toEqual(["text", "image"]);
  });

  it("未知模型只给文本", () => {
    expect(suggestedCapabilities("my-local-llm")).toEqual(["text"]);
    expect(suggestedCapabilities("")).toEqual(["text"]);
  });
});

describe("LLM_PRESETS", () => {
  it("id 唯一且可查", () => {
    const ids = LLM_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of LLM_PRESETS) expect(llmPreset(p.id)).toBe(p);
    expect(llmPreset("nope")).toBeUndefined();
  });

  it("每个预设都有 id/name 与非空字段约束", () => {
    for (const p of LLM_PRESETS) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(typeof p.supportsReasoningEffort).toBe("boolean");
    }
    expect(MODEL_CAPABILITIES).toEqual(["text", "image", "audio", "video"]);
  });

  /**
   * 回归：OpenAI 预设曾预填 `gpt-4o`，用户只是点了「OpenAI」就会得到一个
   * 自己没选过的型号，控制台模型下拉里凭空多出「系统默认模型」。
   * 没有预填型号的预设，由「刷新模型」按供应商实际返回的列表来选。
   */
  it("OpenAI 预设不预填型号", () => {
    expect(llmPreset("openai")?.model).toBe("");
  });
});
