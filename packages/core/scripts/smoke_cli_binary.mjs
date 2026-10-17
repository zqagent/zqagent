#!/usr/bin/env node
/**
 * CLI 单文件可执行程序的冒烟测试：确认它能启动、打印 ZQAgent 横幅，并且不依赖已安装的 Node。
 *
 * 用法：node scripts/smoke_cli_binary.mjs <可执行文件路径>
 *
 * 做法：在「空 PATH + 临时 HOME/USERPROFILE」下启动它（PATH 里没有任何 node，
 * 所以能打印出横幅就说明运行时确实被打进单文件里了），读到横幅后杀掉进程。
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const binary = process.argv[2];
if (!binary || !fs.existsSync(binary)) {
  console.error(`✗ 找不到可执行文件：${binary ?? "(未指定)"}`);
  process.exit(1);
}

// 空的 PATH 目录 + 干净的家目录：既验证不依赖外部 node，也避免污染真实配置。
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-smoke-"));
const emptyBin = path.join(sandbox, "empty-bin");
fs.mkdirSync(emptyBin);

const child = spawn(path.resolve(binary), [], {
  cwd: sandbox,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PATH: emptyBin,
    HOME: sandbox,
    USERPROFILE: sandbox,
    XDG_CONFIG_HOME: path.join(sandbox, "config"),
    XDG_STATE_HOME: path.join(sandbox, "state"),
    // 别让真实凭据影响启动路径
    OPENAI_API_KEY: "",
    ZQAGENT_API_KEY: "",
  },
});

let output = "";
let done = false;
const finish = (code) => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  child.kill("SIGKILL");
  fs.rmSync(sandbox, { recursive: true, force: true });
  if (code !== 0) {
    console.error("✗ 单文件 CLI 冒烟测试失败，输出如下：\n" + output);
  } else {
    console.log(`✓ ${path.relative(process.cwd(), path.resolve(binary))} 启动正常（未使用外部 node）`);
  }
  process.exit(code);
};

const timer = setTimeout(() => finish(output.includes("ZQAgent") ? 0 : 1), 20_000);
const collect = (buf) => {
  output += buf.toString();
  if (output.includes("ZQAgent")) finish(0);
};
child.stdout.on("data", collect);
child.stderr.on("data", collect);
child.on("error", (err) => {
  output += `\nspawn error: ${err.message}`;
  finish(1);
});
child.on("exit", () => finish(output.includes("ZQAgent") ? 0 : 1));
