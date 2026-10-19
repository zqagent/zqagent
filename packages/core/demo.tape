# 生成 README 用的演示 GIF
#
# 直接用 VHS 录交互式 CLI 不可靠：VHS 的 pty 默认只有 46 列，本 CLI 的审批提示
# 会折行；`Wait+Screen` 匹配中文提示也容易失败。所以拆成两步：
#
#   1. capture.py  —— 真实跑一次会话，把终端输出连同时间戳记录下来
#   2. 本 tape     —— 让 VHS 录制 replay.mjs 的回放
#
# 画面内容全部来自第 1 步的真实会话，没有任何人工拼接或伪造。
#
# 依赖：
#   go install github.com/charmbracelet/vhs@latest
#   apt-get install -y fonts-noto-cjk gifsicle
#
# 用法（在已 /connect 配好模型的机器上，于 packages/core 目录执行）：
#   python3 scripts/demo/capture.py
#   vhs demo.tape
#   gifsicle -O3 --colors 128 --lossy=40 demo.gif -o demo-opt.gif
#   cp demo-opt.gif ../docs/assets/demo.gif
#
# 注意：
#   时间线文件含真实会话输出（可能含本机路径），不要提交。
#   GIF 控制在 1MB / 15s 以内，README 首屏加载才不至拖慢。

Output demo.gif

Set Shell "bash"
Set FontSize 14
Set FontFamily "DejaVu Sans Mono"
Set Width 1180
Set Height 760
Set Padding 16
Set Theme "Catppuccin Mocha"
Set Framerate 24

Hide
Type "export PATH=$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | tail -1)/bin:$PATH"
Enter
Type "cd $(pwd)"
Enter
Sleep 400ms
Show

Type "node scripts/demo/replay.mjs"
Enter
Sleep 15s
