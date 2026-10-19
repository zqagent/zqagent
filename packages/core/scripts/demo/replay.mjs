/**
 * README 演示素材第二步：把 capture.py 记录的终端流按原始节奏回放到 stdout，
 * 再由 VHS 录成 GIF。
 *
 * 为什么不在 VHS 里直接跑交互：见 capture.py 顶部说明。
 * 回放的内容全部来自真实会话，没有人工拼接。
 *
 * 用法：
 *   node scripts/demo/replay.mjs
 *
 * 环境变量：
 *   DEMO_IN     时间线文件（默认 ~/.cache/zqagent-demo/timeline.json）
 *   DEMO_SPEED  播放倍速（默认 1.0，2 表示快一倍）
 *   DEMO_TAIL   结束后停留毫秒（默认 2500）
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const file = process.env.DEMO_IN ?? join(homedir(), '.cache', 'zqagent-demo', 'timeline.json');
const speed = Number(process.env.DEMO_SPEED ?? 1);
const tail = Number(process.env.DEMO_TAIL ?? 2500);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chunks;
try {
  chunks = JSON.parse(readFileSync(file, 'utf8'));
} catch {
  console.error(`读不到时间线：${file}\n先运行 python3 scripts/demo/capture.py`);
  process.exit(1);
}

// 清屏后再开始，避免录到回放前的提示符
process.stdout.write('\x1b[2J\x1b[H');
await sleep(600);

let prev = 0;
for (const { t, d } of chunks) {
  const wait = (t - prev) / speed;
  if (wait > 0) await sleep(wait * 1000);
  prev = t;
  process.stdout.write(d);
}

await sleep(tail);
