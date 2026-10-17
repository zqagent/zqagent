# Windows 工具兼容性与后台任务

本文档记录 zqagent CLI 的内置工具在 Windows 上实测发现的问题、根因与修复，
以及新增的后台任务能力。

背景：CLI 单文件在 Windows 上跑通（见
[cli-sea-troubleshooting.md](cli-sea-troubleshooting.md)）后，对文件、shell、
搜索、git、补丁等工具做了一轮实测，暴露出一批平台差异。以下逐项说明。

测试环境：Windows 10 22H2 (19045) x64；PowerShell 5.1（无 pwsh）；
控制台代码页 437；无 ripgrep；Python 为商店占位符；工作区非 git 仓库。

---

## 1. run_shell：stderr / 退出码 / 编码 / 超时

**旧实现**（`packages/core/src/tools/shell.ts`）用 `execSync`/`execFileSync`：

- 成功分支**硬编码** `stderr: ""`、`exit_code: 0`，所以任何命令的 stderr 都被丢弃；
- PowerShell 下 `cmd /c "... & exit /b 7"` 的退出码不会传给 powershell 自身，
  工具拿到的 `exit_code` 恒为 0，真实退出码只在 `$LASTEXITCODE` 里；
- 中文输出被控制台代码页压成 `?`；
- 超时返回裸 `spawnSync ... ETIMEDOUT`，已产出的输出全部丢失。

**修复**：

- 全面改用 `spawnSync`，成功与失败都返回真实的 `stdout` / `stderr` / `exit_code`；
- PowerShell 命令包裹 `...; exit $LASTEXITCODE`，让原生命令退出码冒泡；
- 每次调用前缀 UTF-8 编码设置（见下节）；
- 超时返回 `{ timed_out: true, stdout, stderr, exit_code }`，保留输出。

**模型可用性**：`run_shell` 的 schema 仍为 `command` / `description` /
`timeout_seconds`，返回结构向后兼容并新增 `timed_out`。

## 2. 中文输出被压成 `?`

**根因**：Windows 控制台默认代码页 437。

**修复**（`packages/core/src/tools/shellRuntime.ts` 的 `wrapCommand`）：

- PowerShell 每次调用前缀 `$OutputEncoding = [Console]::OutputEncoding =
  [Text.Encoding]::UTF8;` —— 同一次调用内立即对后续命令生效，规避
  `chcp 65001` 要等下一次调用才生效的问题；
- cmd.exe（含 Windows 下未探测到其它 shell 时的 default）前缀 `chcp 65001>nul &`；
- 子进程 env 追加 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`。

> 注意：Node、git 等原生程序直接吐 UTF-8 字节，本就不受影响；受影响的是
> PowerShell cmdlet 与 cmd 内建命令的输出。

## 3. 后台任务（开发服务器 / watch）

**旧问题**：系统提示词让模型使用 `run_in_background` + `shell_task_output` /
`shell_task_kill`，但这三个名字在工具注册表里并不存在，模型跑不了长驻进程。

**修复**：

- `run_shell` 新增 `run_in_background: boolean` 参数（与提示词「设置
  run_in_background」一致）；
- 新增工具 `shell_task_output(task_id)`、`shell_task_kill(task_id)`；
- 实现见 `packages/core/src/tools/shellBackground.ts`：detached `spawn` + 每个输出流
  64KB 环形缓冲 + 进程树终止（Windows `taskkill /pid <pid> /T /F`，
  POSIX 对进程组发 `SIGKILL`），进程退出时统一清理，避免残留；
- 后台管理器为模块级单例，引擎重建后 `task_id` 仍可查询。

## 4. cwd 不跨调用保持

**根因**：cwd 存在 `makeRunShell` 的闭包里，而 CLI 在 `/mode`、`/agent`、
`/model`、reset 时会重建引擎（重新 `registerShellTool`），闭包随之重置。

**修复**：shell 会话状态提升为模块级 `Map<workspace, {cwd}>`，按工作区隔离、
跨引擎重建保持（`packages/core/src/tools/shell.ts`）。`parseCdChain` 增加 `pushd` /
`Push-Location`（只跟踪目标目录；`popd` 的目录栈语义未实现）。

## 5. grep 退化为 findstr

**旧问题**：Windows 无 rg/grep 时回退 `findstr`，正则能力仅 POSIX 子集
（`\d` / `\s` / `+` / `|` 均不可用）；路径不存在时静默返回 0 匹配。

**修复**：执行策略改为「捆绑 ripgrep → PATH 上的 rg → 纯 Node 扫描器」：

- `packages/core/src/tools/ripgrep.ts`：优先释放 SEA 内嵌的 rg（`node:sea` 的 `getAsset`），
  其次 `ZQAGENT_RG` 指定路径，最后 PATH 上的 rg；
- `packages/core/src/tools/nodeGrep.ts`：纯 Node 兜底，`fs` 递归 + `new RegExp`，支持完整 JS
  正则，跳过 `.git`/`node_modules`/二进制/大文件，路径不存在显式报错；
- 修正退出码语义：rg 退出码 1（无匹配）直接返回空，不再触发后续回退；
- 删除 findstr 分支。

返回体新增 `engine` 字段（`ripgrep` / `node`）便于排查。

### 构建期内嵌 ripgrep

`packages/core/scripts/lib/ripgrep_dist.mjs` 在构建时按目标平台下载 rg 并作为 SEA asset 打包：

- 下载源按序尝试 `ZQAGENT_RG_BUNDLE` 本地文件 → GitHub Release → npmmirror
  的 `ripgrep-prebuilt` 镜像；兼容两种压缩包目录布局（根目录 `rg` 与
  `<stem>/rg`）与 `.sha256` 的两种格式；
- 全部失败时**构建降级**（不阻断），运行时自动回退纯 Node 扫描器；
- 代价：产物每平台约 +5MB。

## 6. git 工具

**旧问题**：

- `git_status` 先对整体输出 `trim()` 再按固定宽度切列，导致第一条
  `" M path"` 的前导空格被吃掉，路径首字符丢失；
- 非 ASCII 文件名被输出成八进制转义（git 默认 `core.quotepath=true`），
  未加 `-c core.quotepath=false`；
- 三个 git 工具固定以工作区根为仓库根，`path` 只能限定输出范围。

**修复**（`packages/core/src/tools/git.ts`）：

- status 逐行解析、去 `\r`，不再整体 `trim`；
- 统一带 `-c core.quotepath=false`；
- `resolveRepoRoot` 用 `git -C <path> rev-parse --show-toplevel` 自动定位
  `path` 所在仓库根，`path` 同时用于限定 scope；
- 全部改用 `spawnSync`，可靠读取 stderr 与退出码。

## 7. apply_patch 对尾随换行敏感

**根因**：`patch.split("\n")` 后取最后一项判断 `*** End Patch`，结尾带换行时
最后一项是空串，于是误报「补丁必须以 `*** End Patch` 结尾」。

**修复**（`packages/core/src/tools/diff.ts`）：归一化 CRLF 并 `trimEnd()` 后再校验/切分，
容忍 `*** End Patch` 后的空行；`apply_unified_diff` 同样归一化 CRLF。

## 8. 声明与实际的一致性

- **启动横幅**：去掉硬编码的「18 个工具 + 清单」，改为启动后从
  `engine.registry.schemas()` 动态打印实际注册且启用中的工具（含 MCP 注入）。
- **explore 子代理**：原先注册 `registerFileTools`（含 write_file /
  replace_in_file），仅靠 Plan 模式权限从机制上拦截，schema 仍声明了写能力。
  现拆出 `registerReadOnlyFileTools`（read_file / list_files），使声明与
  「只读」提示一致。
- **web_search**：DeepSeek 的 Responses 路径会在请求时用服务端内置
  `{type:"web_search"}` 替换本地同名工具（`packages/core/src/providers/OpenAIProvider.ts`），
  这是有意行为；横幅现在反映注册表实际内容，不再硬编码。

---

## 9. 第二轮复检修复

上批修复上线后，在 Windows 上二次复检又发现/确认了若干问题，均已处理。

### 9.1 grep 单文件路径解析错位（回归）

`path` 指向**单个文件**时，`rg` 在单文件模式下不输出文件名前缀，输出为
`行号:内容`，却被按 `文件:行号:内容` 解析，导致 `{"file":"1:内容","line":0}`。

修复（`packages/core/src/tools/search.ts`）：给 rg 显式加 `--with-filename`，强制输出文件名前缀，
目录与单文件两种模式输出格式统一。

### 9.2 git_log 与 git_status 的 path 语义不一致

`git_log` 已与 `git_status` 一样用 `rev-parse --show-toplevel` 定位仓库根，但当
`--show-toplevel` 输出与 `path.resolve` 结果的路径形式不一致时（macOS
`/var`→`/private/var` 符号链接、Windows 短路径/盘符形式等），`toPathspec` 会算出
跑到仓库外的相对路径，`git log -- <path>` 报 “is outside repository”，表现为
“定位不到嵌套仓库 / 0 条提交”。

修复（`packages/core/src/tools/git.ts`）：`toPathspec` 在相对路径以 `..` 开头或为绝对路径时，
用 `fs.realpathSync` 归一后再计算一次；仍无法表达则返回 `null`（退回整仓，不报错）。

### 9.3 web_fetch 不按响应 charset 解码

`Response.text()`（undici / node-fetch）一律按 UTF-8 解码，国内常见的
`Content-Type: charset=GBK` 接口会得到乱码。

修复（`packages/core/src/tools/web.ts`）：新增 `readBodyWithCharset`，改读 `arrayBuffer()`，
优先用 header 的 `charset`，其次嗅探 HTML 的 `<meta charset>`，再回退 UTF-8；
`web_fetch` 的正响应与重定向响应都走它。

### 9.4 PowerShell 解析错误的 stderr 乱码

命令前注入的 `[Console]::OutputEncoding = UTF8` 属于脚本的一部分；当脚本本身有
**语法错误（ParserError）** 时整段不会执行，该行也就没生效，错误由宿主用控制台
OEM 代码页（中文 Windows 为 936/GBK）输出，而 harness 按 UTF-8 读 → 乱码。

修复（`packages/core/src/tools/shell.ts`）：`spawnSync` 不再指定 `encoding`，改拿原始字节，
`decodeOutput` 先严格按 UTF-8 解，失败再依次尝试 GBK / Big5 / Shift_JIS，
从而正确还原解析错误文本。运行时错误的输出不受影响。

### 9.5 cwd 持久化的健壮性

shell 会话状态已提升为模块级、跨引擎重建保持；本轮再把会话键改为
`path.resolve(workspace)`，避免尾斜杠 / 相对路径在不同注册点产生两个会话键。

## 验证

- 单元测试：`test/shell.test.ts`（stderr 捕获、非零退出码、后台任务、`decodeOutput`
  自适应解码）、`test/search.test.ts`（纯 Node 回退、`\d`、路径不存在、单文件路径）、
  `test/git.test.ts`（首条解析、非 ASCII、嵌套仓库 git_status + git_log）、
  `test/diff.test.ts`、`test/web.test.ts`（GBK charset 解码）；
  Windows 分支用注入 `platform:"win32"` 的纯单测覆盖。
- SEA 冒烟：最小 SEA 确认运行时 `sea.getAsset("rg")` 可取到资源。
- 产物：`release/cli/zqagent-windows-x64.exe`（含内嵌 rg.exe）。

## 已知取舍

- cwd 按工作区共享，`popd` 的目录栈语义未实现。
- 捆绑 rg 依赖构建期网络；不可达时降级为纯 Node 扫描（功能完整、性能较低）。
- 纯 Node 扫描器为正确性兜底，大目录下比 rg 慢。
- Windows 产物注入后 Authenticode 签名失效，正式分发前需 `signtool` 重签。
