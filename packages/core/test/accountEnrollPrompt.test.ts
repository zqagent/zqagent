/**
 * 账号接入向导的输入解析（Hub 地址默认值与「跳过」语义）
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_HUB_URL } from "../src/paths.js";
import { parseHubAnswer, resolveDefaultHub } from "../src/cli/account-enroll.js";

describe("账号接入向导 · Hub 地址", () => {
  it("默认值优先级：--hub > HUB_URL > 内置官方地址", () => {
    expect(resolveDefaultHub(undefined, {})).toBe(DEFAULT_HUB_URL);
    expect(resolveDefaultHub(undefined, { HUB_URL: "https://my-hub.example.com" })).toBe(
      "https://my-hub.example.com",
    );
    expect(
      resolveDefaultHub("https://flag.example.com", { HUB_URL: "https://my-hub.example.com" }),
    ).toBe("https://flag.example.com");
  });

  it("容忍空白与结尾斜杠", () => {
    expect(resolveDefaultHub("  https://flag.example.com/ ", {})).toBe(
      "https://flag.example.com",
    );
  });

  it("直接回车采用默认值；输入 - / skip / none 表示跳过", () => {
    const fallback = DEFAULT_HUB_URL;
    expect(parseHubAnswer("", fallback)).toBe(fallback);
    expect(parseHubAnswer("   ", fallback)).toBe(fallback);
    expect(parseHubAnswer("-", fallback)).toBeNull();
    expect(parseHubAnswer("SKIP", fallback)).toBeNull();
    expect(parseHubAnswer("none", fallback)).toBeNull();
  });

  it("自定义地址覆盖默认值并去结尾斜杠", () => {
    expect(parseHubAnswer(" https://my-hub.example.com/ ", DEFAULT_HUB_URL)).toBe(
      "https://my-hub.example.com",
    );
  });
});
