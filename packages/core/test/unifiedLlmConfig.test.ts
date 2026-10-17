/**
 * LLM 配置统一存储（CLI `/connect` ↔ Server 节点配置 共用一份文件）
 *
 * 核心诉求：同一台机器上，CLI 与（以本机用户运行的）server/桌面端配置必须一致。
 * 这里断言：
 *   1. CLI 写入的供应商，server 侧 `loadNodeLlm()` 能读到（含解密后的 key）
 *   2. server 侧 `saveNodeLlm()` 写入的，CLI `listConnections()` 能读到
 *   3. 旧的 `{DATA_DIR}/node-llm.json`（明文 key）自动迁移并加密
 *   4. 迁移只发生一次（不重复导入、不覆盖后续修改）
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Store } from "../src/server/store.js";
import * as conn from "../src/cli/connection.js";
import { llmConfigFile } from "../src/llmConfig.js";

const tmpDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** 每个用例独立的统一配置文件（避免污染开发者本机 ~/.config/zqagent） */
let cfgFile: string;

beforeEach(() => {
  const dir = tmpDir("zqagent-unified-");
  cfgFile = path.join(dir, "connections.json");
  process.env.ZQAGENT_LLM_CONFIG_FILE = cfgFile;
});

afterEach(() => {
  delete process.env.ZQAGENT_LLM_CONFIG_FILE;
  while (tmpDirs.length > 0)
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("CLI 与 Server 共用同一份 LLM 配置", () => {
  it("CLI 写入 → Server 读得到（key 解密正确）", () => {
    conn.addConnection({
      provider: "deepseek",
      baseURL: "https://api.deepseek.com",
      apiKey: "sk-cli-side",
      model: "deepseek-flash",
      reasoningEffort: null,
    });

    const dataDir = tmpDir("zqagent-data-");
    const store = new Store(dataDir);
    const cfg = store.loadNodeLlm();

    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers[0]!.type).toBe("deepseek");
    expect(cfg.providers[0]!.baseURL).toBe("https://api.deepseek.com");
    expect(cfg.providers[0]!.apiKey).toBe("sk-cli-side");
    expect(cfg.defaultProviderId).toBe(cfg.providers[0]!.id);
    // 落盘必须是密文
    expect(fs.readFileSync(cfgFile, "utf8")).not.toContain("sk-cli-side");
  });

  it("Server 写入 → CLI 读得到", () => {
    const dataDir = tmpDir("zqagent-data-");
    const store = new Store(dataDir);
    store.saveNodeLlm({
      providers: [
        {
          id: "p1",
          name: "通义千问",
          type: "qwen",
          baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          model: "qwen-plus",
          apiKey: "sk-server-side",
        },
      ],
      defaultProviderId: "p1",
    });

    const list = conn.listConnections();
    expect(list).toHaveLength(1);
    expect(list[0]!.provider).toBe("qwen");
    expect(list[0]!.model).toBe("qwen-plus");
    expect(list[0]!.active).toBe(true);
    expect(conn.loadConnection()?.apiKey).toBe("sk-server-side");
  });

  it("旧的 node-llm.json（明文 key）自动迁移并加密", () => {
    const dataDir = tmpDir("zqagent-data-");
    fs.writeFileSync(
      path.join(dataDir, "node-llm.json"),
      JSON.stringify({
        providers: [
          {
            id: "legacy1",
            name: "旧配置",
            type: "openai",
            baseURL: "https://api.openai.com/v1",
            model: "gpt-4o",
            apiKey: "sk-legacy-plain",
          },
        ],
        defaultProviderId: "legacy1",
      }),
    );

    const store = new Store(dataDir);
    const cfg = store.loadNodeLlm();
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers[0]!.apiKey).toBe("sk-legacy-plain");
    expect(cfg.defaultProviderId).toBe("legacy1");

    // 已迁移到统一文件，且 key 变为密文
    const raw = fs.readFileSync(cfgFile, "utf8");
    expect(raw).toContain("legacy1");
    expect(raw).not.toContain("sk-legacy-plain");

    // CLI 侧同样可见
    expect(conn.listConnections()[0]!.id).toBe("legacy1");
  });

  it("迁移只发生一次：后续修改不被旧文件覆盖", () => {
    const dataDir = tmpDir("zqagent-data-");
    fs.writeFileSync(
      path.join(dataDir, "node-llm.json"),
      JSON.stringify({
        providers: [
          {
            id: "legacy1",
            name: "旧",
            type: "openai",
            baseURL: "https://a/v1",
            model: "m1",
            apiKey: "k1",
          },
        ],
        defaultProviderId: "legacy1",
      }),
    );

    const store = new Store(dataDir);
    expect(store.loadNodeLlm().providers).toHaveLength(1);

    // 迁移后新增一个供应商
    conn.addConnection({
      provider: "custom",
      baseURL: "https://b/v1",
      apiKey: "k2",
      model: "m2",
      reasoningEffort: null,
    });

    // 再次读取：不应把旧文件重复导入
    expect(store.loadNodeLlm().providers).toHaveLength(2);
    expect(fs.readFileSync(cfgFile, "utf8").match(/legacy1/g)?.length).toBe(1);
  });

  it("reasoningEffort 在两侧往返一致", () => {
    const dataDir = tmpDir("zqagent-data-");
    const store = new Store(dataDir);
    store.saveNodeLlm({
      providers: [
        {
          id: "p1",
          name: "OpenAI",
          type: "openai",
          baseURL: "https://api.openai.com/v1",
          model: "gpt-4o",
          apiKey: "k",
          reasoningEffort: "high",
        },
      ],
      defaultProviderId: "p1",
    });
    expect(store.loadNodeLlm().providers[0]!.reasoningEffort).toBe("high");
  });

  it("配置文件路径与统一模块一致", () => {
    expect(conn.CONNECTION_FILE()).toBe(llmConfigFile());
    expect(llmConfigFile()).toBe(cfgFile);
  });
});
