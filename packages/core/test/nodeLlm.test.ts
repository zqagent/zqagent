/**
 * 节点级 LLM 配置：`nonChat`（非对话模型）的落盘与视图
 *
 * 覆盖：控制台「刷新模型」把 nonChat 随供应商配置保存后，
 *   1. applyNodeLlmPatch 持久化（去重/去空）
 *   2. 旧客户端不传 nonChat 时保留旧值（整体替换语义下的兼容）
 *   3. 显式传空数组时清空
 *   4. nodeLlmView 回显（缺省回空数组，前端可直接用）
 */
import { describe, it, expect } from "vitest";
import { applyNodeLlmPatch, nodeLlmView, type NodeLlmConfig } from "../src/server/nodeLlm.js";

const base = (): NodeLlmConfig => ({
  providers: [{ id: "p1", name: "t1", baseURL: "https://a/v1", model: "m1", apiKey: "k1" }],
  defaultProviderId: "p1",
});

describe("节点级 LLM：nonChat 持久化", () => {
  it("保存候选非对话模型（去重、去空）", () => {
    const next = applyNodeLlmPatch(base(), {
      providers: [
        {
          id: "p1",
          models: ["m1", "text-embedding-3-small"],
          nonChat: ["text-embedding-3-small", " ", "text-embedding-3-small", "whisper-1"],
        },
      ],
    });
    expect(next.providers[0]?.nonChat).toEqual(["text-embedding-3-small", "whisper-1"]);
  });

  it("未传 nonChat 时保留旧值（旧客户端保存不清空）", () => {
    const cfg = base();
    cfg.providers[0]!.nonChat = ["text-embedding-3-small"];
    const next = applyNodeLlmPatch(cfg, {
      providers: [{ id: "p1", models: ["m1"] }],
    });
    expect(next.providers[0]?.nonChat).toEqual(["text-embedding-3-small"]);
  });

  it("显式传空数组时清空", () => {
    const cfg = base();
    cfg.providers[0]!.nonChat = ["text-embedding-3-small"];
    const next = applyNodeLlmPatch(cfg, { providers: [{ id: "p1", nonChat: [] }] });
    expect(next.providers[0]?.nonChat).toEqual([]);
  });

  it("nodeLlmView 回显 nonChat，未设置时回空数组", () => {
    const cfg = base();
    expect(nodeLlmView(cfg).providers[0]?.nonChat).toEqual([]);
    cfg.providers[0]!.nonChat = ["whisper-1"];
    expect(nodeLlmView(cfg).providers[0]?.nonChat).toEqual(["whisper-1"]);
  });
});
