#!/usr/bin/env node
/**
 * 生成节点自动更新的签名密钥对（Ed25519）。
 *
 *   node gen_update_keys.mjs --out .update-keys
 *
 * 产物：
 *   .update-keys/update-private.pem   私钥（放进 CI secret，切勿入库）
 *   .update-keys/update-public.pem    公钥（PEM，可入库/分发）
 *   .update-keys/update-public.b64    公钥（base64 SPKI DER，填到节点的 ZQAGENT_UPDATE_PUBKEY）
 *
 * 节点用 `ZQAGENT_UPDATE_PUBKEY` 验签；未配置时自动更新保持禁用。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { generateKeyPairSync } from "node:crypto";

const outIdx = process.argv.indexOf("--out");
const outDir = outIdx >= 0 ? process.argv[outIdx + 1] : ".update-keys";
if (!outDir) {
  console.error("usage: node gen_update_keys.mjs [--out DIR]");
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicPem = publicKey.export({ type: "spki", format: "pem" });
const publicB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");

fs.writeFileSync(path.join(outDir, "update-private.pem"), privatePem, { mode: 0o600 });
fs.writeFileSync(path.join(outDir, "update-public.pem"), publicPem);
fs.writeFileSync(path.join(outDir, "update-public.b64"), `${publicB64}\n`);

console.log(`已生成 ${outDir}/update-private.pem（私钥，仅放 CI secret）`);
console.log(`已生成 ${outDir}/update-public.pem 与 update-public.b64`);
console.log("");
console.log("节点侧配置（deploy/service/install.sh 或 env）：");
console.log(`  ZQAGENT_UPDATE_PUBKEY=${publicB64.slice(0, 24)}…`);
