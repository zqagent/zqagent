# CLI 单文件（SEA）构建与 Windows 启动排障

本文档记录 **zqagent CLI 单文件可执行程序**（Node SEA）在目标机「启动即静默退出」
的排查方法、一次真实根因分析，以及 Windows 复验清单。

适用读者：负责出包 / 分发 CLI 的人，以及需要在 Windows 上复验产物的同事。

配套脚本：

- 构建产物：`packages/core/scripts/build_cli_binary.mjs`
- 对照探针：`packages/core/scripts/make_sea_probes.mjs`（`pnpm run probes:sea`）
- 共用下载/解压：`scripts/lib/node_dist.mjs`

---

## 1. 问题背景

CLI 单文件用 Node 官方 SEA（Single Executable Application）打包，链路是：

1. `pnpm run build:sea`（tsup）→ `packages/core/dist/sea/zqagent.cjs`（全部依赖打成单个 CJS）
2. `node --experimental-sea-config` → SEA blob
3. 取目标平台 node 可执行文件作基座（本机构建用 `process.execPath`；交叉构建从
   nodejs.org/dist 下载官方发行包并校验 sha256）
4. `postject` 把 blob 注入基座 → 单文件可执行程序

**症状**：在 macOS 上交叉构建出的 `zqagent-windows-x64.exe`，拷到 Windows 后
双击/命令行运行**无任何输出、静默退出**，退出码 `-1073741819`（即 `0xC0000005`，
Windows `STATUS_ACCESS_VIOLATION`）。连 `--debug` 写的日志文件都不生成。

> 关键点：`0xC0000005` 发生在 **JS 尚未执行之前**，所以任何「应用内部初始化」层面的
> 排查都够不着它——必须在「加载器 / SEA 注入 / JS 执行」三层之间做隔离对照。

---

## 2. 对照探针三件套

`pnpm run probes:sea` 会产出三个**最小样本** + 一个诊断脚本，用于在目标机上做分层对照：

| 产物 | 含义 | 作用 |
| --- | --- | --- |
| `_node-base-<ver>-<platform>-<arch>` | 官方 node 基座，零修改 | 对照组 A：排除「系统/安全软件/加载器」层面 |
| `_sea-minimal-probe-<platform>-<arch>` | 最小 SEA 探针，交叉构建时 `useCodeCache=false` | 对照组 B：正常配置 |
| `_sea-cc-probe-<platform>-<arch>` | 同上但 `useCodeCache=true` | 对照组 C：复现可疑配置 |
| `diagnose.cmd`（仅 win32） | 一键跑完 1~5 项并记录 `%ERRORLEVEL%` | 目标机取证 |

用法：

```bash
node packages/core/scripts/make_sea_probes.mjs                    # win32-x64（默认）
node packages/core/scripts/make_sea_probes.mjs --arch arm64       # win32-arm64
node packages/core/scripts/make_sea_probes.mjs --platform linux   # 本机 linux-x64
node packages/core/scripts/make_sea_probes.mjs --platform darwin  # macOS 探针（本机可跑）
```

产物落在 `release/cli/`（该目录已 gitignore，不入库）。

### 判读表

在目标机上逐个执行，记下输出与 `%ERRORLEVEL%`：

| 现象 | 结论 |
| --- | --- |
| A 跑不起来 | 与打包无关：系统 / 安全软件 / 加载器层面拦截 |
| A、B 正常，**C 秒退** | **跨平台 V8 code cache 是元凶**（Node 官方要求交叉构建关闭 `useCodeCache`） |
| A、B、C 都正常 | 问题在 zqagent 自身依赖初始化，用 `--debug` 继续查 |
| B 也秒退、退出码非 0 | SEA 注入 / 加载层问题（`0xC0000005` 等） |

探针除打印 stdout 外，还会往临时目录写 `zqagent-probe.log`——万一「控制台看不到
输出」，落盘日志仍能证明 JS 是否真的跑起来了。

---

## 3. 真实案例：跨平台 code cache 导致秒崩

### 3.1 现场取证（`diagnose.cmd` 输出）

| 测试 | 内容 | 结果 |
| --- | --- | --- |
| TEST 1 | 官方 node 基座 | ✅ `exit=0` |
| TEST 2 | SEA 探针 `useCodeCache=false` | ✅ 正常启动，还写出了 log |
| TEST 3 | SEA 探针 `useCodeCache=true` | ⚠️ 能启动但**行为已损坏**：`require(...).join is not a function` |
| TEST 4 | **真实产物** `zqagent-windows-x64.exe --debug` | ❌ `exit=-1073741819`（`0xC0000005`），log 为 MISSING |

### 3.2 根因

时间线完全对得上：

- `zqagent-windows-x64.exe` 的 mtime 是 **14:52**。
- 当时构建脚本（`c20dd8c`）里 `makeBlob` **硬编码** `useCodeCache: true`，交叉构建也不例外：

  ```js
  // c20dd8c 版本（生成 14:52 那个 exe 用的）
  function makeBlob(bundlePath, tmpDir) {
    ...
    useCodeCache: true,   // ← 交叉构建也用 true
  ```

- 修复提交 `027b62c`（15:25）才改为只在**本机构建**启用：

  ```js
  const blobPath = makeBlob(bundlePath, tmpDir, isNative);  // 交叉构建 → false
  ```

**结论**：在 macOS 上交叉构建 Windows exe 时，SEA blob 里被塞进了 **构建机（macOS）
平台编译的 V8 code cache**。Node 官方文档（Single executable applications）明确要求：
为另一个平台生成 blob 时 `useCodeCache` / `useSnapshot` 必须为 `false`，否则目标机
加载的是异构平台的字节码——轻则逻辑错乱（TEST 3 的 `path.join is not a function`
就是 cached 字节码错位），重则直接 `0xC0000005` 崩溃（TEST 4 的真实产物）。

### 3.3 旁证

- 旧 exe `76285952` B → 修复后新 exe `75731968` B，正好少了 **≈541 KB**，
  即之前被错误塞进 blob 的那段 code cache。
- 阴性对照 `_sea-cc-probe`（`useCodeCache=true`）在 Windows 上持续报
  `path.join is not a function`，而 `_sea-minimal-probe`（`=false`）干净——同一份源码、
  只切换一个开关，对照成立。

### 3.4 修复处理

- 代码修复已在 `027b62c`：`useCodeCache` 仅本机构建为 `true`，交叉构建一律 `false`。
- 重新出包（win32-x64）：

  ```bash
  node packages/core/scripts/build_cli_binary.mjs --platform win32 --arch x64
  # [sea] 生成 SEA blob（useCodeCache=false）…   ← 关键
  # [sea] ✓ 完成：release/cli/zqagent-windows-x64.exe
  ```

---

## 4. Windows 复验清单

**前置**：把新产物 `release/cli/zqagent-windows-x64.exe` 拷到目标机目录（如 `D:\cli\`），
**覆盖**旧文件（旧文件是带 macOS code cache 的坏版本）。

> 注意：每次重新构建，SEA blob 头会记录临时目录的绝对路径，**产物 sha256 每次都会变**，
> 不要拿注入后产物做同一性比对；**size 才是稳定特征**。

### 步骤 1 — 直接验证真实产物

```cmd
D:\cli>set ZQAGENT_DEBUG_LOG=%USERPROFILE%\zqagent-debug.log
D:\cli>if exist "%ZQAGENT_DEBUG_LOG%" del /f /q "%ZQAGENT_DEBUG_LOG%"
D:\cli>echo quit|zqagent-windows-x64.exe --debug
D:\cli>echo exit=%ERRORLEVEL%
D:\cli>type "%USERPROFILE%\zqagent-debug.log"
```

| 检查项 | 通过标准 |
| --- | --- |
| 退出码 | `exit=0`（不再出现 `-1073741819`） |
| 调试日志 | `zqagent-debug.log` **存在且非空**（修复前为 MISSING） |
| 控制台 | 能正常进入 CLI / 响应 `quit` |

### 步骤 2 — 跑诊断脚本交叉确认

```cmd
D:\cli>diagnose.cmd
```

| 测试 | 预期 |
| --- | --- |
| TEST 1 官方 node | `exit=0`（不变） |
| TEST 2 探针 no-cc | `exit=0`，正常写 log（不变） |
| TEST 3 探针 cc（阴性对照） | 仍报 `require(...).join is not a function`，`exit=0` —— **故意保留的坏样本，出现即正常** |
| **TEST 4 真实产物 `--debug`** | **`exit=0` 且不再 MISSING**（关键判据） |

### 步骤 3 — 边界确认（可选）

- 换一台**未装 Node** 的 Windows 机器跑步骤 1，确认 SEA 自包含。
- 若仍失败，抓取 `zqagent-debug.log` 全文 + `%ERRORLEVEL%` +
  `diagnose.cmd` 中 TEST 4/5 的完整输出。

---

## 5. 注意事项

- **交叉构建必须关闭 code cache**：`build_cli_binary.mjs` 现按 `isNative` 自动决定；
  若手动改 SEA config 或新增构建入口，务必遵守同一规则。
- **Windows 签名**：`postject` 注入会破坏 node.exe 自带的 Authenticode 签名
  （构建时会提示 `The signature seems corrupted!`），产物按「未签名」处理；
  **正式分发前用 `signtool` 重新签名**。
- **macOS 签名**：macOS 产物注入前需 `codesign --remove-signature`，注入后需
  `codesign --sign - --force` 临时签名；交叉到 macOS 的产物只能在 macOS 上补签。
- **冒烟测试只能在目标平台跑**：交叉产物在本机无法执行，本机能做的只有注入自检
  （fuse 翻转 / `NODE_SEA_BLOB` / blob 尾部 / `__zqagentDebug` 引导存在）。
- **下载基座需联网**：交叉构建从 nodejs.org/dist 下载发行包并对照 `SHASUMS256.txt`
  校验；日志会打印完整 URL 与 `useCodeCache` 取值，便于确认构建配置。

---

## 6. 后续修复：SEA `require` 警告与 `/connect` 密码回显

产物能正常启动后，Windows 上又暴露了两个问题，均已修复。

### 6.1 启动时的 `require()` 警告

```
Warning: Currently the require() provided to the main script embedded into
single-executable applications only supports loading built-in modules.
```

**根因**：`node-fetch@2` 在模块顶层执行 `convert = require('encoding').convert`
（可选依赖，包在 try/catch 里），而 `encoding` 并未安装，esbuild 就把它保留成
运行时 `require`。SEA 内嵌脚本的 `require` 只支持内置模块，于是 Node 打印该警告
并抛错（被 node-fetch 的 catch 吞掉，功能未受影响）。

**修复**：

- 新增空桩 `scripts/stubs/encoding.cjs`（node-fetch 仅在非 UTF-8 转码时使用
  `convert`，不提供时行为与「require 抛错被 catch」一致）；
- `tsup.sea.config.ts` 用 `esbuildOptions.alias` 把 `encoding` 指向该桩，让
  esbuild 直接内联，bundle 里不再有非内置 `require`。

验证：新产物启动输出中该警告出现 0 次。

### 6.2 `/connect` 输入 API Key 时逐字符追加 `*` 且最终为空

**现象**：输入每个字符显示成「明文 + `*`」，Enter 后报「API Key 不能为空」。

**根因**：`readPassword` 只调用了 `rl.pause()`，但 readline 挂在 stdin 上的
`data` 监听（keypress 解码）仍在消费输入并回显明文，两个消费者抢同一个 stdin。

**修复**（`packages/core/src/cli/index.ts`）：读取期间先 `listeners("data")` 保存、再
`removeAllListeners("data")` 摘掉 readline，读完在 `cleanup()` 里原样恢复，
让 raw 读取独占 stdin。

验证：pty 驱动真实 SEA 产物，输出为 `API Key (DeepSeek): **********`
（对 `sk-test123` 恰好 10 个 `*`，无明文），且流程正常继续到模型列表刷新，
证明 key 非空。

---

## 7. Windows 工具兼容性

CLI 在 Windows 上跑通后，对内置工具做了一轮实测，修复了 stderr/退出码/编码/
后台任务/grep/git/apply_patch 等多处兼容性问题，详见
[windows-tool-compat.md](windows-tool-compat.md)。
