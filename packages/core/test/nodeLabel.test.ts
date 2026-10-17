/**
 * 节点改名：本地持久化 + 舰队指令落地
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import { setupServerHandlers } from "../src/server/interact.js";
import { dispatchFleetCommand } from "../src/server/fleet/FleetCommands.js";
import type { FleetCmdEnvelope } from "@zqagent/shared/fleet";
import type { StreamChunk, ProviderClient } from "../src/index.js";

function textChunk(content: string): StreamChunk {
  return { content, reasoning: null, toolCalls: null, usage: null, finishReason: "stop" };
}
const provider: ProviderClient = {
  async stream() {
    return (async function* () {
      yield textChunk("ok");
    })();
  },
  async chat() {
    return null;
  },
};

function tmpStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-node-"));
  return { root, store: new Store(root) };
}

describe("节点改名", () => {
  it("保存/读取 label，且不因重建 id 丢失", () => {
    const { store } = tmpStore();
    store.saveNodeId("node-1");
    store.saveNodeLabel("我的节点");
    expect(store.loadNodeLabel()).toBe("我的节点");
    expect(store.loadNodeId()).toBe("node-1");
    // 再次写 id（例如 ensureNodeId 回写）不应清掉 label
    store.saveNodeId("node-1");
    expect(store.loadNodeLabel()).toBe("我的节点");
  });

  it("set_node_label 指令写入本地配置", async () => {
    const { store } = tmpStore();
    const manager = new SessionManager(store, 60000, { providerFactory: () => provider });
    setupServerHandlers(manager);
    const env = {
      t: Date.now(),
      nonce: "n1",
      reqId: "r1",
      type: "set_node_label",
      clientId: "c1",
      nodeId: "node-1",
      payload: { label: "客厅树莓派" },
      sig: "x",
    } as unknown as FleetCmdEnvelope;
    const ack = await dispatchFleetCommand({ store, manager }, env);
    expect(ack.ok).toBe(true);
    expect(store.loadNodeLabel()).toBe("客厅树莓派");
  });
});
