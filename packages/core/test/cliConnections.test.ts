/**
 * /connect 连接配置（多供应商 + 加密落盘）单测
 *
 * 重点覆盖「换端点后名字没跟着换」这一历史缺陷：把 DeepSeek 的连接改成
 * 阿里兼容模式后，`/providers` 列表里它仍顶着 "DeepSeek" 的旧名字，
 * 用户完全看不出当前连的是谁。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

type ConnModule = typeof import("../src/cli/connection.js");

const tmpDirs: string[] = [];

/** 独立的配置目录 + 未加载过的 connection 模块 */
async function withFreshConfig<T>(
  fn: (m: ConnModule, dir: string) => T | Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-conn-"));
  tmpDirs.push(dir);
  vi.resetModules();
  // llmConfigFile() 惰性解析该变量，重置模块后即指向新目录
  vi.stubEnv("ZQAGENT_LLM_CONFIG_FILE", path.join(dir, "connections.json"));
  const m = (await import("../src/cli/connection.js")) as ConnModule;
  return fn(m, dir);
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const CFG = {
  provider: "custom",
  baseURL: "https://maas.qianwenaiapi.com/compatible-mode/v1",
  apiKey: "sk-test-ali",
  model: "qwen3.8-flash",
  reasoningEffort: "high" as const,
};

describe("连接名的时效性", () => {
  it("新增连接的自动名 = 供应商标签 · 模型", async () => {
    await withFreshConfig(async (m) => {
      m.addConnection(CFG);
      expect(m.listConnections()[0]!.name).toBe(
        "其它 (OpenAI 兼容) · qwen3.8-flash",
      );
    });
  });

  it("saveConnection 覆盖旧连接时同步刷新自动名", async () => {
    await withFreshConfig(async (m) => {
      m.saveConnection({
        ...CFG,
        provider: "deepseek",
        baseURL: "https://api.deepseek.com",
        model: "deepseek-flash",
      });
      expect(m.listConnections()[0]!.name).toBe("DeepSeek · deepseek-flash");

      // 换成阿里端点 + 新模型：名字必须跟着变
      m.saveConnection(CFG);
      const s = m.listConnections()[0]!;
      expect(s.provider).toBe("custom");
      expect(s.model).toBe("qwen3.8-flash");
      expect(s.name).toBe("其它 (OpenAI 兼容) · qwen3.8-flash");
    });
  });

  it("读取时就地修复历史遗留的陈旧名（并落盘，只修一次）", async () => {
    await withFreshConfig(async (m, dir) => {
      // 伪造旧版本 saveConnection 留下的脏数据：provider 已是 custom，名字还是 DeepSeek
      const file = path.join(dir, "connections.json");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({
          version: 2,
          activeId: "a1",
          providers: [
            {
              id: "a1",
              name: "DeepSeek",
              provider: "custom",
              baseURL: CFG.baseURL,
              apiKeyEnc: "v1:x:y:z",
              model: CFG.model,
              reasoningEffort: null,
            },
          ],
        }),
      );

      const list = m.listConnections();
      expect(list[0]!.name).toBe("其它 (OpenAI 兼容) · qwen3.8-flash");
      // 已落盘：下次读取不需要再修
      expect(fs.readFileSync(file, "utf8")).toContain(
        "其它 (OpenAI 兼容) · qwen3.8-flash",
      );
    });
  });

  it("用户自定义的名字不被自动改名覆盖", async () => {
    await withFreshConfig(async (m) => {
      m.addConnection(CFG, "我的阿里直连");
      expect(m.listConnections()[0]!.name).toBe("我的阿里直连");
      m.saveConnection({ ...CFG, model: "qwen3.8-max" });
      expect(m.listConnections()[0]!.name).toBe("我的阿里直连");
    });
  });
});

describe("API Key 加密落盘", () => {
  it("明文 key 不写入磁盘，且能被解密回来", async () => {
    await withFreshConfig(async (m, dir) => {
      m.addConnection(CFG);
      const raw = fs.readFileSync(path.join(dir, "connections.json"), "utf8");
      expect(raw).not.toContain("sk-test-ali");
      expect(raw).toContain("v1:");
      expect(m.loadConnection()?.apiKey).toBe("sk-test-ali");
      expect(m.loadConnection()?.reasoningEffort).toBe("high");
    });
  });
});
