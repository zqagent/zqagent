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
 *   node scripts/build_cli_binary.mjs --platform linux --arch x64 --libc glibc-217
 *                                                           # glibc 2.17 兼容产物（CentOS 7 等）
 *
 * 注意：
 *   - 交叉组装不需要目标平台硬件（postject 只写文件、不执行），Windows 的 zip 基座由本脚本
 *     内置解压；注入后会自检 fuse 与 blob，避免「注入静默失败、到目标机才发现」。
 *   - 交叉构建会关闭 SEA 的 useCodeCache，本机构建才启用：Node 官方要求为另一个平台生成
 *     blob 时 useCodeCache / useSnapshot 必须为 false，否则会带上构建机的 V8 code cache，
 *     目标机上可能启动即崩溃。
 *   - 注入会剥掉 Mach-O 原有的代码签名，而 Apple Silicon 要求至少 ad-hoc 签名才会执行
 *     （未签名直接被内核 SIGKILL）。macOS 上用 codesign 重签；Linux 上可用 rcodesign
 *     （apple-codesign）完成同样的 ad-hoc 签名，否则构建直接失败，不产出跑不了的产物。
 *     Windows 产物注入后 node.exe 自带的 Authenticode 签名会失效，正式分发需用 signtool 重新签名。
 *   - 交叉组装的产物在本机无法执行，冒烟测试只能在目标平台（或对应 CI runner）上跑。
 *   - 本脚本需要 Node >= 20（SEA 从 20 起提供）。
 *   - `--libc glibc-217` 使用 unofficial-builds 的同版本 glibc 2.17 基座，供 CentOS 7 /
 *     麒麟 V10 等老 glibc 系统使用；产物名带 `-glibc217` 后缀，清单键为
 *     `linux-x64-glibc217`（安装脚本按系统 glibc 选择）。
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
    libc: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v) fail(`${arg} 缺少取值`);
      return v;
    };
    switch (arg) {
      // `pnpm run build:cli-bin -- --platform ...` 会把分隔符原样传进来
      case "--": break;
      case "--platform": opts.platform = value(); break;
      case "--arch": opts.arch = value(); break;
      case "--node-version": opts.nodeVersion = value(); break;
      case "--libc": opts.libc = value(); break;
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
function makeBlob(bundlePath, tmpDir, useCodeCache, assets, nodePath = process.execPath) {
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
  run(nodePath, ["--experimental-sea-config", configPath]);
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

/**
 * 查找 Linux 上可用的 rcodesign（apple-codesign）。
 * 优先级：ZQAGENT_RCODESIGN 显式指定 > PATH 中的 rcodesign。
 */
function findRcodesign() {
  const explicit = process.env.ZQAGENT_RCODESIGN;
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["rcodesign"], {
    encoding: "utf8",
  });
  if (which.status !== 0) return null;
  const found = which.stdout.split("\n")[0].trim();
  return found || null;
}

/**
 * 检查 Mach-O 是否带有效的 embedded code signature。
 *
 * postject 注入时会摘掉 node 原有的签名，之后必须重新签名；这一步把
 * 「忘了签名」变成构建期错误，而不是到 macOS 上启动即崩溃。
 */
function verifyMachOSignature(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0xfeedfacf) {
    fail(`自检失败：${path.basename(file)} 不是 64 位 Mach-O`);
  }
  const ncmds = buf.readUInt32LE(16);
  let off = 32;
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(off);
    const size = buf.readUInt32LE(off + 4);
    if (cmd === 0x1d /* LC_CODE_SIGNATURE */) {
      const dataoff = buf.readUInt32LE(off + 8);
      const datasize = buf.readUInt32LE(off + 12);
      if (datasize < 12 || dataoff + datasize > buf.length) {
        fail(`自检失败：${path.basename(file)} 的代码签名段损坏`);
      }
      if (buf.readUInt32BE(dataoff) !== 0xfade0cc0 /* CSMAGIC_EMBEDDED_SIGNATURE */) {
        fail(`自检失败：${path.basename(file)} 的代码签名格式不正确`);
      }
      return;
    }
    if (size < 8) fail(`自检失败：${path.basename(file)} 的 load command 损坏`);
    off += size;
  }
  fail(`自检失败：${path.basename(file)} 缺少代码签名（macOS 会拒绝启动）`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.libc) {
    const normalized = String(opts.libc).replace(/-/g, "").toLowerCase();
    if (normalized !== "glibc217") fail(`不支持的 --libc：${opts.libc}（可用：glibc-217）`);
    if (opts.libc && opts.arch !== "x64") {
      fail("glibc 2.17 兼容基座目前只提供 linux x64");
    }
    if (opts.platform !== "linux") fail("--libc 只适用于 linux 产物");
    opts.libc = normalized;
  }

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 20) {
    fail(`本脚本需要 Node >= 20（当前 ${process.version}）；SEA 从 Node 20 起提供。`);
  }
  if (!SUPPORTED[opts.platform]) fail(`不支持的平台：${opts.platform}`);
  if (!SUPPORTED[opts.platform].includes(opts.arch)) {
    fail(`${opts.platform} 不支持架构 ${opts.arch}（支持：${SUPPORTED[opts.platform].join(" / ")}）`);
  }

  const isNative = opts.platform === process.platform && opts.arch === process.arch;
  const libcSuffix = opts.libc === "glibc217" ? "-glibc217" : "";
  const bundlePath = path.join(ROOT, "dist", "sea", "zqagent.cjs");
  const outPath =
    opts.out ??
    path.join(
      ROOT,
      "release",
      "cli",
      `zqagent-${DISPLAY_PLATFORM[opts.platform]}-${opts.arch}${libcSuffix}${opts.platform === "win32" ? ".exe" : ""}`,
    );

  if (opts.skipBuild) {
    if (!fs.existsSync(bundlePath)) fail(`--skip-build 需要已存在的 ${bundlePath}`);
  } else {
    log("打包单文件 bundle（tsup.sea.config.ts）…");
    // 变体标记在构建期注入 bundle：更新器据此选择清单键（linux-x64-glibc217），
    // 否则 CentOS 7 上的节点升级时会下载回不兼容的官方 glibc 产物。
    run("npm", ["run", "build:sea"], {
      env: { ...process.env, ZQAGENT_LIBC_VARIANT: opts.libc ?? "" },
    });
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

    // glibc 兼容产物必须用同版本的兼容基座来生成 blob：SEA blob 与基座的
    // V8 版本绑定，不能用构建机（或另一个 libc 变体）的 node 代劳。
    const needsDownloadedBase = !isNative || Boolean(opts.libc);
    let baseBinary;
    if (needsDownloadedBase) {
      try {
        baseBinary = await fetchNodeBase(
          opts.nodeVersion,
          opts.platform,
          opts.arch,
          tmpDir,
          log,
          opts.libc ? "glibc-217" : undefined,
        );
      } catch (err) {
        fail(err.message);
      }
    } else {
      baseBinary = process.execPath;
    }
    log(
      `基座：${baseBinary}${needsDownloadedBase ? `（下载的发行包${opts.libc ? "，glibc 2.17 兼容" : ""}）` : "（本机 node）"}`,
    );

    // 只有本机构建、且基座就是当前 node 时才启用 code cache：官方要求为其它
    // 目标生成 blob 时关闭，否则可能带上构建机的 V8 cache。
    //
    // 生成 blob 的 node 必须是当前机器能执行的：跨平台/跨架构的基座（如 Linux 上
    // 构建 darwin 产物）根本无法在本机运行。只有「同平台同架构、仅 libc 变体不同」
    // 时才用下载的基座，保证 blob 与基座的 V8 版本一致。
    const baseRunsHere = opts.platform === process.platform && opts.arch === process.arch;
    const blobNode = needsDownloadedBase && baseRunsHere ? baseBinary : process.execPath;
    const blobPath = makeBlob(bundlePath, tmpDir, isNative && !opts.libc, assets, blobNode);

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
        // 注入已剥掉 node 自带的签名，Apple Silicon 上未签名的可执行文件会被内核
        // 直接 SIGKILL。Linux 没有 codesign，用 rcodesign 做等价的 ad-hoc 签名。
        const rcodesign = findRcodesign();
        if (!rcodesign) {
          fail(
            "macOS 产物必须签名后才能运行，但当前平台没有 codesign 也没有 rcodesign。\n" +
              "  方案一：在 macOS 上构建（CI 的 macos runner 即可）；\n" +
              "  方案二：在 Linux 安装 rcodesign 后重试：\n" +
              "    https://github.com/indygreg/apple-platform-rs/releases\n" +
              "    （或用 ZQAGENT_RCODESIGN 指定可执行文件路径）",
          );
        }
        log(`重新签名（ad-hoc，${path.basename(rcodesign)}）…`);
        run(rcodesign, ["sign", outPath]);
      }
      verifyMachOSignature(outPath);
    } else if (opts.platform === "win32") {
      log(
        "提示：注入破坏了 node.exe 自带的 Authenticode 签名（postject 的 " +
          "`signature seems corrupted` 警告即此），产物按「未签名」处理；正式分发前用 signtool 重新签名。",
      );
    }

    verifyInjection(outPath, blobPath);

    const sizeMb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
    log(
      `✓ 完成：${path.relative(ROOT, outPath)}（${sizeMb} MB，${opts.platform}-${opts.arch}${opts.libc ? "，glibc 2.17 兼容" : ""}）`,
    );
  } finally {
    if (opts.keepTemp) log(`保留临时目录：${tmpDir}`);
    else fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

await main();
