/**
 * 测试全局 setup
 *
 * LLM 配置默认落在开发者本机的 `~/.config/zqagent/connections.json`。
 * 测试若直接读写，会污染真实配置、且用例之间互相干扰，
 * 因此这里统一把 `ZQAGENT_LLM_CONFIG_FILE` 指向每文件独立的临时路径。
 * （vitest 默认 isolate：每个测试文件有独立的模块环境，故互不影响。）
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-test-llm-"));
process.env.ZQAGENT_LLM_CONFIG_FILE = path.join(dir, "connections.json");
