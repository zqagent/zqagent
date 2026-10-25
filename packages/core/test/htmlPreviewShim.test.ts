/**
 * HTML 预览的隔离垫片（console-ui `useHtmlPreview` 的 SHIM）
 *
 * 背景：预览用 `sandbox="allow-scripts allow-forms"`（不给 allow-same-origin），
 * 文档因此是 opaque origin。实测该环境下：
 *   - `history.pushState` / `replaceState` 抛 SecurityError
 *   - `localStorage` 抛 SecurityError
 *   - `location.hash = "#x"` 不抛错，但不会滚动到目标元素
 *
 * 前两条最要命：大量静态站（锚点导航、tab 切换、hash 路由）在初始化时就会调
 * `replaceState`，一抛错整段脚本中断，页面自带的加载动画永远停在屏幕上 ——
 * 用户看到的就是「打开 HTML 预览后进入动画一直转」。
 *
 * 这里用假 DOM 跑一遍真实 SHIM 源码，锁住「不抛错 + 锚点自己滚」这两条。
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const SOURCE_PATH = path.join(ROOT, "packages/console-ui/src/lib/useHtmlPreview.ts");
const SRC = fs.readFileSync(SOURCE_PATH, "utf8");

/** 从源码里取出注入到预览文档的 SHIM 字符串 */
function shimSource(): string {
  const m = SRC.match(/const SHIM = `([\s\S]*?)`;/);
  if (!m) throw new Error("SHIM 未找到");
  return m[1]!;
}

interface FakeEvent {
  target: unknown;
  preventDefault(): void;
  stopPropagation(): void;
}

interface FakeEnv {
  window: Record<string, unknown>;
  document: Record<string, unknown>;
  history: Record<string, unknown>;
  location: { hash: string };
  /** 记录 scrollIntoView / scrollTo 的落点 */
  scrolled: string[];
  clickHandlers: Array<(e: FakeEvent) => void>;
  hashChangeHandlers: Array<() => void>;
}

function makeEnv(): FakeEnv {
  const scrolled: string[] = [];
  const clickHandlers: Array<(e: FakeEvent) => void> = [];
  const hashChangeHandlers: Array<() => void> = [];
  const elements: Record<string, { scrollIntoView: () => void }> = {
    sec: { scrollIntoView: () => scrolled.push("sec") },
    "named-anchor": { scrollIntoView: () => scrolled.push("named-anchor") },
  };

  const windowObj: Record<string, unknown> = {
    sessionStorage: undefined,
    scrollTo: (x: number, y: number) => scrolled.push(`scrollTo:${x},${y}`),
    scrollY: 0,
    addEventListener: (type: string, fn: () => void) => {
      if (type === "hashchange") hashChangeHandlers.push(fn);
    },
  };
  // 读 localStorage 抛错 → 走内存垫片分支（与 sandbox 下的 SecurityError 一致）
  Object.defineProperty(windowObj, "localStorage", {
    get() {
      throw new Error("SecurityError");
    },
    configurable: true,
  });

  const documentObj: Record<string, unknown> = {
    addEventListener: (type: string, fn: (e: FakeEvent) => void) => {
      if (type === "click") clickHandlers.push(fn);
    },
    getElementById: (id: string) => elements[id] ?? null,
    getElementsByName: (name: string) => (elements[name] ? [elements[name]] : []),
  };

  const securityError = () => {
    throw Object.assign(new Error("SecurityError"), { name: "SecurityError" });
  };
  const historyObj: Record<string, unknown> = {
    pushState: securityError,
    replaceState: securityError,
  };

  return {
    window: windowObj,
    document: documentObj,
    history: historyObj,
    location: { hash: "" },
    scrolled,
    clickHandlers,
    hashChangeHandlers,
  };
}

function runShim(env: FakeEnv): void {
  // SHIM 只依赖这四个全局对象，以参数注入即可隔离运行
  const fn = new Function("window", "document", "history", "location", shimSource());
  fn(env.window, env.document, env.history, env.location);
}

/** 造一个「点击 a[href]」事件，返回是否被 preventDefault */
function clickAnchor(env: FakeEnv, href: string): boolean {
  let prevented = false;
  const anchor = { getAttribute: (name: string) => (name === "href" ? href : null) };
  env.clickHandlers[0]!({
    target: { closest: (sel: string) => (sel === "a[href]" ? anchor : null) },
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {},
  });
  return prevented;
}

describe("HTML 预览垫片：历史 API 降级", () => {
  it("replaceState / pushState 不再抛 SecurityError，并退化为改 hash", () => {
    const env = makeEnv();
    runShim(env);

    expect(() => (env.history.replaceState as Function)({ a: 1 }, "", "#sec")).not.toThrow();
    expect(env.location.hash).toBe("#sec");

    expect(() => (env.history.pushState as Function)({ a: 2 }, "", "#named-anchor")).not.toThrow();
    expect(env.location.hash).toBe("#named-anchor");
  });

  it("localStorage 换成内存实现（原对象不可读）", () => {
    const env = makeEnv();
    runShim(env);
    const ls = env.window.localStorage as {
      setItem(k: string, v: string): void;
      getItem(k: string): string | null;
      length: number;
    };
    ls.setItem("k", "v");
    expect(ls.getItem("k")).toBe("v");
    expect(ls.length).toBe(1);
  });
});

describe("HTML 预览垫片：锚点", () => {
  it("#锚点：阻止默认行为并滚到目标元素", () => {
    const env = makeEnv();
    runShim(env);
    expect(clickAnchor(env, "#sec")).toBe(true);
    expect(env.scrolled).toEqual(["sec"]);
  });

  it("支持老式 <a name> 锚点", () => {
    const env = makeEnv();
    runShim(env);
    clickAnchor(env, "#named-anchor");
    expect(env.scrolled).toEqual(["named-anchor"]);
  });

  it("#top：滚回顶部", () => {
    const env = makeEnv();
    runShim(env);
    clickAnchor(env, "#top");
    expect(env.scrolled).toContain("scrollTo:0,0");
  });

  it("页面脚本改 location.hash 时，hashchange 负责滚动", () => {
    const env = makeEnv();
    runShim(env);
    env.location.hash = "#sec";
    env.hashChangeHandlers.forEach((fn) => fn());
    expect(env.scrolled).toEqual(["sec"]);
  });

  it("相对链接仍被拦下（否则预览会跳到 Hub 的 404）", () => {
    const env = makeEnv();
    runShim(env);
    expect(clickAnchor(env, "/other/page.html")).toBe(true);
  });
});

describe("HTML 预览垫片：注入位置", () => {
  /**
   * 页面自己的内联脚本按文档顺序执行。若垫片追加到 head 末尾，head 里那些开场
   * 就调 replaceState 的脚本会先跑、照样抛错，加载动画照样卡住 —— 实测过：
   * 追加在末尾等同于不注入。必须插在 head 最前面。
   */
  it("插到 head 最前面，而不是 appendChild", () => {
    expect(SRC).toContain("head.insertBefore(shim, head.firstChild)");
    expect(SRC).not.toContain("head.appendChild(shim)");
  });
});
