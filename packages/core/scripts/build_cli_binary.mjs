#!/usr/bin/env node
/**
 * 构建「免装 Node」的 CLI 单文件可执行程序（Node SEA）
 *
 * 打包链路：
 *   1. `npm run build:sea`（tsup.sea.config.ts）→ dist/sea/zqagent.cjs
 *      把全部第三方依赖打进一个 CJS 文件（SEA blob 只允许 require 内置模块）
 *   2. `node --experimental-sea-config` → zqagent 的 SEA blob
 *   3. 取目标平台的 node 可执行文件作基座（本机构建直接用 process.execPath；
 *      交叉构建时从 nodejs.org/dist 下载对应 平台+架构 的官方发行包并校验 sha256）
 *   4. postject 把 blob 注入基座 → 单文件可执行程序（无需目标机安装 Node）
 *
 * 用法：
 *   node scripts/build_cli_binary.mjs                       # 当前平台 + 当前架构
 *   node scripts/build_cli_binary.mjs --arch arm64          # 交叉组装 macos/linux arm64
 *   node scripts/build_cli_binary.mjs --platform win32 --arch arm64 --node-version v22.22.3
 *
 * 注意：
 *   - 交叉组装不需要目标平台硬件（postject 只写文件、不执行），Windows 的 zip 基座由本脚本
 *     内置解压；注入后会自检 fuse 与 blob，避免「注入静默失败、到目标机才发现」。
 *   - 交叉构建会关闭 SEA 的 useCodeCache，本机构建才启用：Node 官方要求为另一个平台生成
 *     blob 时 useCodeCache / useSnapshot 必须为 false，否则会带上构建机的 V8 code cache，
 *     目标机上可能启动即崩溃。
 *   - macOS 产物的临时签名（codesign）只能在 macOS 上做；Windows 产物注入后 node.exe 自带的
 *     Authenticode 签名会失效，正式分发需用 signtool 重新签名。
 *   - 交叉组装的产物在本机无法执行，冒烟测试只能在目标平台（或对应 CI runner）上跑。
 *   - 本脚本需要 Node >= 20（SEA 从 20 起提供）。
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchNodeBase } from "./lib/node_dist.mjs";
import { fetchRipgrep } from "./lib/ripgrep_dist.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Node 官方发行包支持的 平台 × 架构（与 CI 矩阵一致） */
const SUPPORTED = {
  darwin: ["x64", "arm64"],
  linux: ["x64", "arm64"],
  win32: ["x64", "arm64"],
};

/** 产物命名用的平台名（与桌面端 build_* 脚本保持一致） */
const DISPLAY_PLATFORM = { darwin: "macos", win32: "windows", linux: "linux" };

const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function log(...args) {
  console.log(`[sea] ${args.join(" ")}`);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: ROOT,
    // Windows 上 npm / tsup 是 .cmd 包装脚本，必须经 shell 才能执行
    shell: process.platform === "win32",
    ...opts,
  });
  if (result.error) fail(`无法执行 ${cmd}：${result.error.message}`);
  if (result.status !== 0) fail(`命令失败（exit=${result.status}）：${cmd} ${args.join(" ")}`);
}

function parseArgs(argv) {
  const opts = {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    out: null,
    skipBuild: false,
    keepTemp: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v) fail(`${arg} 缺少取值`);
      return v;
    };
    switch (arg) {
      case "--platform": opts.platform = value(); break;
      case "--arch": opts.arch = value(); break;
      case "--node-version": opts.nodeVersion = value(); break;
      case "--out": opts.out = path.resolve(value()); break;
      case "--skip-build": opts.skipBuild = true; break;
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

/**
 * 生成 SEA blob，返回 blob 路径。
 *
 * `useCodeCache` 必须区分本机构建与交叉构建（Node 官方文档「Single executable
 * applications」明确要求：为另一个平台生成时 useCodeCache / useSnapshot 都得关掉，
 * 否则产出的可执行程序可能在目标机启动时崩溃——因为 blob 里带的是**构建机**编译的
 * V8 code cache）。本机同平台构建沿用 code cache 以省启动时间。
 */
function makeBlob(bundlePath, tmpDir, useCodeCache, assets) {
  const blobPath = path.join(tmpDir, "zqagent.blob");
  const configPath = path.join(tmpDir, "sea-config.json");
  const hasAssets = assets && Object.keys(assets).length > 0;
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        main: bundlePath,
        output: blobPath,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache,
        // 内嵌资源（如 rg 可执行文件），运行时经 node:sea 的 getAsset 释放
        ...(hasAssets ? { assets } : {}),
      },
      null,
      2,
    ),
  );
  log(`生成 SEA blob（useCodeCache=${useCodeCache}${hasAssets ? `, assets=${Object.keys(assets).join(",")}` : ""}）…`);
  run(process.execPath, ["--experimental-sea-config", configPath]);
  return blobPath;
}

/**
 * 注入后自检：SEA fuse 必须已翻转，且 blob 内容确实写进了产物。
 *
 * 交叉构建时无法执行目标平台的产物（Windows 的 .exe / 另一架构的二进制都跑不了），
 * 注入若因格式不匹配静默失败，要到用户手上才发现 —— 这里提前拦下。
 */
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
  // 诊断引导（`--debug`）必须一并打进 blob，否则「模块初始化期崩溃」在目标机上
  // 没有任何取证手段（tsup.sea.config.ts 的 banner 是它唯一的来源）
  if (!blob.includes(Buffer.from("__zqagentDebug"))) {
    fail(
      `自检失败：${path.basename(file)} 缺少诊断启动引导（tsup.sea.config.ts 的 banner 未生效）`,
    );
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

  const isNative = opts.platform === process.platform && opts.arch === process.arch;
  const bundlePath = path.join(ROOT, "dist", "sea", "zqagent.cjs");
  const outPath =
    opts.out ??
    path.join(
      ROOT,
      "release",
      "cli",
      `zqagent-${DISPLAY_PLATFORM[opts.platform]}-${opts.arch}${opts.platform === "win32" ? ".exe" : ""}`,
    );

  if (opts.skipBuild) {
    if (!fs.existsSync(bundlePath)) fail(`--skip-build 需要已存在的 ${bundlePath}`);
  } else {
    log("打包单文件 bundle（tsup.sea.config.ts）…");
    run("npm", ["run", "build:sea"]);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-sea-"));
  try {
    // 内嵌目标平台的 ripgrep（best-effort）：失败不阻断，运行时回退纯 Node 扫描器
    const assets = {};
    try {
      assets.rg = await fetchRipgrep(opts.platform, opts.arch, tmpDir, log);
      log("ripgrep 已内嵌");
    } catch (err) {
      log(`⚠️  未能内嵌 ripgrep（${err.message}）；grep 将回退纯 Node 扫描器`);
    }

    const blobPath = makeBlob(bundlePath, tmpDir, isNative, assets);
    let baseBinary;
    if (isNative) {
      baseBinary = process.execPath;
    } else {
      try {
        baseBinary = await fetchNodeBase(opts.nodeVersion, opts.platform, opts.arch, tmpDir, log);
      } catch (err) {
        fail(err.message);
      }
    }
    log(`基座：${baseBinary}${isNative ? "（本机 node）" : "（下载的发行包）"}`);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(baseBinary, outPath);
    fs.chmodSync(outPath, 0o755);

    // macOS 上必须先摘掉 node 自带签名，注入后才能重新签名
    if (opts.platform === "darwin" && process.platform === "darwin") {
      spawnSync("codesign", ["--remove-signature", outPath], { stdio: "inherit" });
    }

    const { inject } = await loadPostject();
    log("注入 SEA blob …");
    await inject(outPath, "NODE_SEA_BLOB", fs.readFileSync(blobPath), {
      sentinelFuse: SEA_FUSE,
      ...(opts.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
    });

    if (opts.platform === "darwin") {
      if (process.platform === "darwin") {
        run("codesign", ["--sign", "-", "--force", outPath]);
      } else {
        log("提示：macOS 产物需在 macOS 上执行 `codesign --sign - --force <file>` 后才能运行");
      }
    } else if (opts.platform === "win32") {
      log(
        "提示：注入破坏了 node.exe 自带的 Authenticode 签名（postject 的 " +
          "`signature seems corrupted` 警告即此），产物按「未签名」处理；正式分发前用 signtool 重新签名。",
      );
    }

    verifyInjection(outPath, blobPath);

    const sizeMb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
    log(`✓ 完成：${path.relative(ROOT, outPath)}（${sizeMb} MB，${opts.platform}-${opts.arch}）`);
  } finally {
    if (opts.keepTemp) log(`保留临时目录：${tmpDir}`);
    else fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

await main();
