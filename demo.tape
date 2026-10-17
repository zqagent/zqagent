# VHS 录制脚本：生成 README 用的交互演示 GIF
#
# 安装 VHS：https://github.com/charmbracelet/vhs
#   brew install vhs            # macOS
#   go install github.com/charmbracelet/vhs@latest
#
# 使用（在已 /connect 配好模型的机器上，进入任意测试仓库）：
#   vhs demo.tape
#   得到 demo.gif 后，替换 README 里 ./docs/assets/cli-help.svg 那一段。
#
# 注意：
#   1. 本脚本只录制真实运行过程，不做任何后处理拼接。
#   2. 任务文案请按你的演示仓库调整，确保文件真实存在。
#   3. 录制前清屏、关闭无关输出，GIF 控制在 10 秒内转化率最好。

Output demo.gif

Set Shell "bash"
Set FontSize 16
Set FontFamily "JetBrains Mono, Menlo, monospace"
Set Width 1100
Set Height 640
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms
Set Framerate 30

# 启动
Type "zqagent"
Enter
Sleep 3s

# 只读任务：不需要审批，展示探索能力
Type "读一下这个项目，用三句话总结它是做什么的"
Enter
Sleep 12s

# 有副作用的操作：展示审批卡片（这屏是核心卖点，停留久一点）
Type "把 README.md 末尾的 TODO 段落删掉"
Enter
Sleep 4s
Type "Y"
Sleep 3s

# 收尾
Sleep 2s
