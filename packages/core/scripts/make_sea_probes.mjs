#!/usr/bin/env node
/**
 * 生成「对照探针」三件套，用于定位可执行程序在目标机上启动即静默退出的问题。
 *
 * 排查思路：把「加载器 / SEA 注入 / JS 执行」三层拆开，各出一个最小样本，
 * 在出问题的机器上逐个跑，看谁先死、退出码是多少。
 *
 *   1. _node-base-<ver>-<platform>-<arch>   官方 node 基座，零修改（对照组 A）
 *   2. _sea-minimal-probe-<platform>-<arch> 最小 SEA 探针，交叉构建时 useCodeCache=false（对照组 B）
 *   3. _sea-cc-probe-<platform>-<arch>      同上但 useCodeCache=true（对照组 C，复现可疑配置）
 *
 * 判读（在目标机上逐个执行，记下输出与 %ERRORLEVEL%）：
 *   A 跑不起来            → 与我们的打包无关：系统/安全软件/加载器层面就拦了
 *   A、B 正常、C 秒退     → 跨平台 V8 code cache 是元凶（Node 官方要求交叉构建关闭 useCodeCache）
 *   A、B、C 都正常        → 问题在 zqagent 自身的依赖初始化，用 `--debug` 继续查
 *   B 也秒退、退出码非 0  → SEA 注入/加载层问题（0xC0000005 等）
 *
 * 探针除了打印 stdout，还会往临时目录写 zqagent-probe.log —— 万一是「控制台看不到输出」，
 * 落盘日志仍能证明 JS 是否真的跑起来了。
 *
 * 用法：
 *   node scripts/make_sea_probes.mjs                          # win32-x64（默认）
 *   node scripts/make_sea_probes.mjs --arch arm64             # win32-arm64
 *   node scripts/make_sea_probes.mjs --platform linux         # 本机 linux-x64
 *   node scripts/make_sea_probes.mjs --platform darwin        # 在 macOS 上生成 macos 探针（本机可跑）
 *
 * 注意：本脚本需要 Node >= 20（SEA 从 20 起提供）；交叉构建不需要目标平台硬件。
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DIST_PLATFORM, fetchNodeBase, sha256Of } from "./lib/node_dist.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Node 官方发行包支持的 平台 × 架构 */
const SUPPORTED = {
  darwin: ["x64", "arm64"],
  linux: ["x64", "arm64"],
  win32: ["x64", "arm64"],
};

const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

/** 产物命名用的平台名（与 build_cli_binary.mjs 保持一致，用于在诊断脚本里指向真实产物） */
const DISPLAY_PLATFORM = { darwin: "macos", win32: "windows", linux: "linux" };

/** 探针正文：证明 SEA 加载器 + JS 执行 + stdout 三件事都走通了 */
const PROBE_JS = `const fs = require("node:fs");
const line =
  "[probe] sea alive: node=" + process.version +
  " platform=" + process.platform +
  " arch=" + process.arch +
  " exe=" + process.execPath;
console.log(line);
try {
  fs.appendFileSync(require("node:path").join(require("node:os").tmpdir(), "zqagent-probe.log"), line + "\\n");
} catch (err) {
  console.log("[probe] log write failed: " + err.message);
}
`;

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/**
 * 生成 Windows 端诊断脚本。
 *
 * 由本脚本产出而不是提交一个静态文件：产物目录（release/）整目录不入库，而 .cmd 里的文件名
 * 必须与三件套严格同名——放在一处生成，命名就不会各自漂移。
 */
function writeDiagnoseCmd(outDir, names) {
  const exe = (name) => `%D%${name}`;
  const lines = [
    "@echo off",
    "setlocal enabledelayedexpansion",
    "chcp 437 >nul 2>nul",
    "",
    "rem ============================================================",
    "rem  ZQAgent Windows startup diagnosis",
    "rem  Put this script next to the .exe files and run it",
    "rem  (double-click, or run it inside cmd).",
    "rem  When it fails, copy ALL text above the final banner",
    "rem  (including every 'exit=' line) and send it back.",
    "rem ============================================================",
    "",
    'set "D=%~dp0"',
    `if not exist "${exe(names.pkg)}" set "D=%CD%\\"`,
    'set "LOG=%USERPROFILE%\\zqagent-debug.log"',
    'set "PLOG=%TEMP%\\zqagent-probe.log"',
    "",
    "rem delete old logs first, so a stale run is never mistaken for this one",
    'if exist "%LOG%" del /f /q "%LOG%" >nul 2>nul',
    'if exist "%PLOG%" del /f /q "%PLOG%" >nul 2>nul',
    "",
    "echo ============================================================",
    "echo   ZQAgent Windows startup diagnosis",
    'echo   looking for files in: %D%',
    "echo ============================================================",
    "echo.",
    "",
    `echo ---- TEST 1: official node.exe, zero modification (${names.base}) ----`,
    `if exist "${exe(names.base)}" (`,
    `    "${exe(names.base)}" -e "console.log('node-ok')"`,
    "    echo    exit=!ERRORLEVEL!",
    ") else ( echo    SKIP - file not present )",
    "echo.",
    "",
    `echo ---- TEST 2: minimal SEA probe, no code cache (${names.nocc}) ----`,
    `if exist "${exe(names.nocc)}" (`,
    `    "${exe(names.nocc)}"`,
    "    echo    exit=!ERRORLEVEL!",
    ") else ( echo    SKIP - file not present )",
    "echo.",
    "",
    `echo ---- TEST 3: minimal SEA probe WITH code cache (${names.cc}) ----`,
    `if exist "${exe(names.cc)}" (`,
    `    "${exe(names.cc)}"`,
    "    echo    exit=!ERRORLEVEL!",
    ") else ( echo    SKIP - file not present )",
    "echo.",
    "",
    `echo ---- TEST 4: zqagent --debug (${names.pkg}) ----`,
    `if exist "${exe(names.pkg)}" (`,
    '    set "ZQAGENT_DEBUG_LOG=%LOG%"',
    `    echo quit|"${exe(names.pkg)}" --debug`,
    "    echo    exit=!ERRORLEVEL!",
    '    echo    --- log: %LOG% ---',
    '    if exist "%LOG%" ( type "%LOG%" ) else ( echo    [MISSING] no log file was written )',
    ") else ( echo    SKIP - file not present )",
    "echo.",
    "",
    "echo ---- TEST 5: probe log file (proves JS actually ran) ----",
    'echo    --- log: %PLOG% ---',
    'if exist "%PLOG%" ( type "%PLOG%" ) else ( echo    [MISSING] probes wrote no log - JS never executed )',
    "echo.",
    "",
    "echo ============================================================",
    "echo   copy ALL text above and send it back",
    "echo   exit=0 means the program ran; other values are the real clue",
    "echo ============================================================",
    "pause",
  ];
  // Windows 批处理必须 CRLF；内容保持纯 ASCII，避免中文代码页下解析异常
  const file = path.join(outDir, "diagnose.cmd");
  fs.writeFileSync(file, `${lines.join("\r\n")}\r\n`);
  return file;
}

function log(...args) {
  console.log(`[probe] ${args.join(" ")}`);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, shell: false, ...opts });
  if (result.error) fail(`无法执行 ${cmd}：${result.error.message}`);
  if (result.status !== 0) fail(`命令失败（exit=${result.status}）：${cmd} ${args.join(" ")}`);
}

function parseArgs(argv) {
  const opts = { platform: "win32", arch: "x64", nodeVersion: process.version, out: null, keepTemp: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v) fail(`${arg} 缺少取值`);
      return v;
    };
    switch (arg) {
      // `pnpm run probes:sea -- --arch ...` 会把分隔符原样传进来
      case "--": break;
      case "--platform": opts.platform = value(); break;
      case "--arch": opts.arch = value(); break;
      case "--node-version": opts.nodeVersion = value(); break;
      case "--out": opts.out = path.resolve(value()); break;
      case "--keep-temp": opts.keepTemp = true; break;
      case "-h":
      case "--help":
        console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
        process.exit(0);
        break;
      default:
        fail(`未知参数：${arg}`);
    }
  }
  return opts;
}

/** 生成 SEA blob（同一份 main，只切换 useCodeCache），返回 blob 路径 */
function makeBlob(mainPath, blobPath, useCodeCache) {
  const configPath = `${blobPath}.json`;
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      { main: mainPath, output: blobPath, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache },
      null,
      2,
    ),
  );
  run(process.execPath, ["--experimental-sea-config", configPath]);
  return blobPath;
}

/** 注入后自检：fuse 必须已翻转、blob 必须确实写进产物（交叉构建只能这样验） */
function verifyInjection(file, blobPath) {
  const buf = fs.readFileSync(file);
  const fuse = Buffer.from(SEA_FUSE);
  const at = buf.indexOf(fuse);
  if (at < 0) fail(`自检失败：${path.basename(file)} 中找不到 SEA fuse`);
  if (buf.toString("latin1", at + fuse.length, at + fuse.length + 2) !== ":1") {
    fail(`自检失败：${path.basename(file)} 的 SEA fuse 未翻转（blob 不会被加载）`);
  }
  if (!buf.includes(Buffer.from("NODE_SEA_BLOB"))) {
    fail(`自检失败：${path.basename(file)} 中找不到 NODE_SEA_BLOB`);
  }
  const blob = fs.readFileSync(blobPath);
  if (!buf.includes(blob.subarray(blob.length - 64))) {
    fail(`自检失败：${path.basename(file)} 中未找到 blob 尾部内容`);
  }
}

async function loadPostject() {
  try {
    return await import("postject");
  } catch {
    fail("缺少依赖 postject，请先执行 `npm install`（postject 已列入 devDependencies）");
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 20) {
    fail(`本脚本需要 Node >= 20（当前 ${process.version}）；SEA 从 Node 20 起提供。`);
  }
  if (!SUPPORTED[opts.platform]) fail(`不支持的平台：${opts.platform}`);
  if (!SUPPORTED[opts.platform].includes(opts.arch)) {
    fail(`${opts.platform} 不支持架构 ${opts.arch}（支持：${SUPPORTED[opts.platform].join(" / ")}）`);
  }

  const ver = String(opts.nodeVersion).replace(/^v/, "");
  const tag = `${DIST_PLATFORM[opts.platform]}-${opts.arch}`;
  const ext = opts.platform === "win32" ? ".exe" : "";
  const outDir = opts.out ?? path.join(ROOT, "release", "cli");
  const isNative = opts.platform === process.platform && opts.arch === process.arch;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-probe-"));
  try {
    // 注意：blob 里会记下 main 脚本的绝对路径（堆栈里显示用），所以临时目录名带随机后缀时，
    // 每次注入出的产物 sha256 都不同——校验同一性请看基座 hash，别拿注入后产物做比对。
    const mainPath = path.join(tmpDir, "probe.js");
    fs.writeFileSync(mainPath, PROBE_JS);

    const noccBlob = makeBlob(mainPath, path.join(tmpDir, "probe-nocc.blob"), false);
    const ccBlob = makeBlob(mainPath, path.join(tmpDir, "probe-cc.blob"), true);

    let baseBinary;
    if (isNative) {
      baseBinary = process.execPath;
      log(`基座：${baseBinary}（本机 node）`);
    } else {
      try {
        baseBinary = await fetchNodeBase(opts.nodeVersion, opts.platform, opts.arch, tmpDir, log);
      } catch (err) {
        fail(err.message);
      }
    }

    fs.mkdirSync(outDir, { recursive: true });
    const baseBuf = fs.readFileSync(baseBinary);
    const names = {
      base: `_node-base-v${ver}-${tag}${ext}`,
      nocc: `_sea-minimal-probe-${tag}${ext}`,
      cc: `_sea-cc-probe-${tag}${ext}`,
      pkg: `zqagent-${DISPLAY_PLATFORM[opts.platform]}-${opts.arch}${ext}`,
    };
    const outputs = [
      { file: path.join(outDir, names.base), buf: baseBuf, blob: null },
      { file: path.join(outDir, names.nocc), buf: baseBuf, blob: noccBlob },
      { file: path.join(outDir, names.cc), buf: baseBuf, blob: ccBlob },
    ];

    const { inject } = await loadPostject();
    const injectOptions = {
      sentinelFuse: SEA_FUSE,
      ...(opts.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
    };

    const rows = [];
    for (const item of outputs) {
      fs.writeFileSync(item.file, item.buf);
      fs.chmodSync(item.file, 0o755);
      if (item.blob) {
        // 官方 node 是签过名的：注入前必须先摘签名，注入后再临时签名
        if (opts.platform === "darwin" && process.platform === "darwin") {
          spawnSync("codesign", ["--remove-signature", item.file], { stdio: "inherit" });
        }
        log(`注入 ${path.basename(item.file)}（blob ${fs.statSync(item.blob).size} B）…`);
        await inject(item.file, "NODE_SEA_BLOB", fs.readFileSync(item.blob), injectOptions);
        if (opts.platform === "darwin" && process.platform === "darwin") {
          run("codesign", ["--sign", "-", "--force", item.file]);
        }
        verifyInjection(item.file, item.blob);
      }
      rows.push({
        name: path.basename(item.file),
        size: `${(fs.statSync(item.file).size / 1024 / 1024).toFixed(1)} MB`,
        sha256: sha256Of(fs.readFileSync(item.file)),
      });
    }

    console.log("");
    const relOut = path.relative(ROOT, outDir);
    log(`产物目录：${relOut.startsWith("..") ? outDir : relOut || "."}`);
    for (const row of rows) {
      console.log(`  ${row.name.padEnd(40)} ${row.size.padStart(9)}  sha256=${row.sha256}`);
    }
    if (opts.platform === "win32") {
      const cmd = writeDiagnoseCmd(outDir, names);
      console.log(`  ${path.basename(cmd).padEnd(40)} ${"(诊断脚本)".padStart(9)}`);
    }
    console.log("");
    log("把这三件套拷到目标机同一目录后逐个执行，记录输出与 %ERRORLEVEL%（Windows）。");
    log("探针另会在目标机临时目录写 zqagent-probe.log，可用它确认 JS 是否真的执行过。");
    if (!isNative) {
      log("提示：交叉产物无法在本机执行，只能靠注入自检 + 目标机实测验证。");
    }
  } finally {
    if (opts.keepTemp) log(`保留临时目录：${tmpDir}`);
    else fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

await main();
