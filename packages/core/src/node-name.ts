/**
 * 节点显示名的默认值。
 *
 * 接入 Hub 时若没显式给 `--label`，用主机名：Hub 界面显示的是可读的机器名，
 * 而不是一串 nodeId。用户之后可在 Hub 界面或本机 `zqagent rename` 修改。
 */
import * as os from "os";

export function defaultNodeLabel(): string {
  const name = os.hostname().trim();
  return name || "zqagent-node";
}
