#!/usr/bin/env python3
"""
录制 README 演示素材的第一步：跑一次真实会话并记录终端输出。

为什么不用 VHS 直接录交互：
  VHS 的 pty 默认只有 46 列，本 CLI 的审批提示会折行；
  `Wait+Screen` 匹配中文提示也不可靠。所以改成「真实会话 → 缓存终端流 → 回放录制」。

用法：
    python3 scripts/demo/capture.py            # 生成 /tmp/demo-timeline.json
    vhs demo.tape                             # 由 replay.mjs 回放并录制

前置条件：
    - 已通过 `zqagent` 的 /connect 配好模型（~/.config/zqagent/connections.json）
    - 有 python3

注意：输出的 timeline 含真实会话内容（可能含本机路径），不要提交。
"""

import json
import os
import pty
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time

TASK = "把 src/api/user.js 里的请求超时改成 3 秒，然后跑测试"
# 输出放在用户缓存目录而非 /tmp：/tmp 会被系统清理，导致回放时读不到文件。
WORK_ROOT = os.environ.get(
    "DEMO_WORK_DIR", os.path.join(os.path.expanduser("~"), ".cache", "zqagent-demo")
)
OUT = os.environ.get("DEMO_OUT", os.path.join(WORK_ROOT, "timeline.json"))
TIMEOUT = float(os.environ.get("DEMO_TIMEOUT", "120"))

SOURCE_FILES = {
    "package.json": """{
  "name": "demo-app",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
""",
    "src/api/user.js": """const TIMEOUT_MS = 5000;

export async function fetchUser(id) {
  const res = await fetch(`https://api.example.com/users/${id}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export { TIMEOUT_MS };
""",
    "test/user.test.js": """import test from "node:test";
import assert from "node:assert/strict";
import { TIMEOUT_MS } from "../src/api/user.js";

test("请求超时应为 3 秒", () => {
  assert.equal(TIMEOUT_MS, 3000);
});
""",
}


def make_demo_project() -> str:
    """建一个"测试失败、需要改代码"的小项目，让演示有真实的因果。"""
    os.makedirs(WORK_ROOT, exist_ok=True)
    root = os.path.join(WORK_ROOT, "demo-app")
    shutil.rmtree(root, ignore_errors=True)
    for rel, body in SOURCE_FILES.items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(body)
    return root


def main() -> int:
    cli = shutil.which("zqagent")
    if not cli:
        # 源码目录里跑时，退回到仓库内的入口
        here = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        candidate = os.path.join(here, "bin", "zqagent")
        cli = candidate if os.path.exists(candidate) else None
    if not cli:
        print("找不到 zqagent，请先 npm i -g @zqagent/core 或在 packages/core 下执行", file=sys.stderr)
        return 1

    workdir = make_demo_project()

    env = os.environ.copy()
    env["TERM"] = "xterm-256color"
    env.pop("CI", None)

    master, slave = pty.openpty()
    proc = subprocess.Popen(
        [cli], cwd=workdir, stdin=slave, stdout=slave, stderr=slave,
        env=env, preexec_fn=os.setsid,
    )
    os.close(slave)

    chunks: list[dict] = []
    t0 = time.time()
    sent = approved = 0
    last_data = t0

    def record(data: bytes) -> None:
        chunks.append({"t": round(time.time() - t0, 3),
                       "d": data.decode("utf-8", "replace")})

    while time.time() - t0 < TIMEOUT:
        ready, _, _ = select.select([master], [], [], 0.3)
        elapsed = time.time() - t0
        if ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            record(data)
            last_data = time.time()
            if "允许一次" in data.decode("utf-8", "replace"):
                # 逐字符输入，让画面出现"人在按键"的过程
                for ch in "a":
                    os.write(master, ch.encode())
                    time.sleep(0.08)
                    record(ch.encode())
                os.write(master, b"\r")
                time.sleep(0.05)
                record(b"\r")
                approved += 1
        else:
            if not sent and elapsed > 3.0:
                for ch in TASK:
                    os.write(master, ch.encode())
                    time.sleep(0.035)
                    record(ch.encode())
                os.write(master, b"\r")
                time.sleep(0.05)
                record(b"\r")
                sent = 1
            elif approved >= 2 and time.time() - last_data > 5:
                break

    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:
        pass

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(chunks, f, ensure_ascii=False)

    text = "".join(c["d"] for c in chunks)
    print(f"分块 {len(chunks)} 个，时长 {time.time() - t0:.1f}s → {OUT}")
    for kw in ("需要审批", "允许一次", "任务完成"):
        print(f"  {kw}: {text.count(kw)} 次")
    if "任务完成" not in text:
        print("警告：没跑到「任务完成」，检查模型连接或调大 DEMO_TIMEOUT", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
