/**
 * CLI 启动横幅：ZQAgent 大号字标 + 对角渐变色
 *
 * 启动时把品牌名渲染成 figlet 风格的块状字标（只保留实心块，无投影/阴影，
 * 远比方块 `# ZQAgent` 标题醒目），并按列/行位置叠加对角渐变，做出类似
 * opencode 启动页的观感。
 *
 * 降级策略与 terminal.ts 一致：
 *   - Unicode 不支持（传统 Windows 控制台）时退回纯 ASCII 方框字标；
 *   - 无颜色（非 TTY / NO_COLOR / chalk.level===0）时只输出字标本体。
 * 返回文本经 cliWrite 输出，颜色使用 ANSI 转义码，不污染重定向到文件的场景。
 */
import chalk from "chalk";

/** 字标内容（大写字标） */
export const BRAND_TEXT = "ZQAGENT";
/**
 * 副标题：保留品牌名原始大小写（scripts/smoke_cli_binary.mjs 依赖输出含 "ZQAgent"）。
 */
export const BRAND_TAGLINE = "ZQAgent · AI Agent CLI";

/**
 * 字标字形：figlet 块状字体去掉阴影，仅含 ZQAGENT 所需字母。
 * 每字 6 行、8 列宽（右侧另留 1 列间距），各字母的左右竖笔与横画按同一套栅格对齐。
 */
const GLYPHS: Record<string, string[]> = {
  Z: ["███████ ", "   ███  ", "  ███   ", " ███    ", "███████ ", "        "],
  Q: [" ██████ ", "██    ██", "██    ██", "██ ▄▄ ██", " ██████ ", "     ▀▀ "],
  A: [" ██████ ", "██    ██", "████████", "██    ██", "██    ██", "        "],
  G: [" ██████ ", "██      ", "██   ███", "██    ██", " ██████ ", "        "],
  E: ["███████ ", "██      ", "███████ ", "██      ", "███████ ", "        "],
  N: ["██    ██", "███   ██", "████  ██", "██ ██ ██", "██  ████", "        "],
  T: ["████████", "   ██   ", "   ██   ", "   ██   ", "   ██   ", "        "],
};

/** 字标行数（所有字形等高） */
const GLYPH_ROWS = 6;
/**
 * 字形槽宽：8 列字形 + 3 列字间距，用于逐字拼装。
 *
 * 间距取 3 列是为了让块状字母之间充分分开——1~2 列时间距与字形内部的
 * 笔画空隙接近，远看仍像连成一整块色带。
 * 7 个字母总宽 74 列，这是 80 列终端能容纳的上限：再加 1 列就是 80 列，
 * 终端稍有内边距就会折行（banner.test.ts 有 ≤79 的断言）。
 */
const GLYPH_COLS = 11;

/** 对角渐变停靠色（青 → 靛 → 品红），t∈[0,1] 线性插值 */
const GRADIENT: ReadonlyArray<readonly [number, number, number]> = [
  [34, 211, 238],
  [99, 102, 241],
  [217, 70, 239],
];

/**
 * 用块状字形拼出字标（无颜色）。遇未知字符回退为空格占位，保证拼装不错位。
 */
export function renderBrandArt(text: string = BRAND_TEXT): string {
  const lines: string[] = [];
  for (let r = 0; r < GLYPH_ROWS; r++) {
    let line = "";
    for (const ch of text) {
      const glyph = GLYPHS[ch];
      line += (glyph ? glyph[r]! : " ".repeat(GLYPH_COLS)).padEnd(GLYPH_COLS);
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines.join("\n");
}

/** 传统控制台可用的纯 ASCII 方框字标 */
function asciiBrandArt(text: string): string {
  const inner = 40;
  const padded =
    text.length >= inner
      ? text.slice(0, inner)
      : " ".repeat(Math.floor((inner - text.length) / 2)) + text;
  const rule = "+" + "-".repeat(inner) + "+";
  return [rule, "|" + padded.padEnd(inner) + "|", rule].join("\n");
}

/** 渐变取值：把 t∈[0,1] 映射到 GRADIENT 停靠色之间的 RGB */
function gradientAt(t: number): [number, number, number] {
  const clamped = Math.min(1, Math.max(0, t));
  const span = GRADIENT.length - 1;
  const pos = clamped * span;
  const i = Math.min(span - 1, Math.floor(pos));
  const local = pos - i;
  const a = GRADIENT[i]!;
  const b = GRADIENT[i + 1]!;
  const mix = (x: number, y: number) => Math.round(x + (y - x) * local);
  return [mix(a[0], b[0]), mix(a[1], b[1]), mix(a[2], b[2])];
}

/** RGB → xterm 256 色索引（6×6×6 色立方近似，供 chalk.level===2 使用） */
function to256(r: number, g: number, b: number): number {
  const q = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/**
 * 给字标叠加对角渐变。
 * `level` 取自 chalk.level：0=不着色，1=基础亮色，2=256 色，3=真彩色。
 * 空白字符保持无色，仅避免多余转义码。
 */
export function colorizeBrandArt(art: string, level: number = chalk.level): string {
  if (level <= 0) return art;
  const lines = art.split("\n");
  const width = Math.max(...lines.map((l) => l.length));
  const height = lines.length;
  const open = (r: number, g: number, b: number): string =>
    level >= 3 ? `\x1b[38;2;${r};${g};${b}m` : level === 2 ? `\x1b[38;5;${to256(r, g, b)}m` : "\x1b[96m";
  return lines
    .map((line, row) =>
      Array.from(line)
        .map((ch, col) => {
          if (ch === " " || ch === "\t") return ch;
          const t = (col / Math.max(1, width - 1) + row / Math.max(1, height - 1)) / 2;
          const [r, g, b] = gradientAt(t);
          return open(r, g, b) + ch + "\x1b[39m";
        })
        .join(""),
    )
    .join("\n");
}

export interface BannerOptions {
  /** 是否使用 Unicode 字形（false 时退回纯 ASCII 方框），默认 true */
  unicode?: boolean;
  /** 颜色等级（chalk.level）；默认取当前进程探测值 */
  level?: number;
}

/** 渲染完整启动横幅（含末尾换行），供 cliWrite 直接输出 */
export function renderBanner(opts: BannerOptions = {}): string {
  const unicode = opts.unicode ?? true;
  const level = opts.level ?? chalk.level;
  const art = unicode ? renderBrandArt(BRAND_TEXT) : asciiBrandArt(BRAND_TEXT);
  // 无颜色时不着色，保持重定向到文件/日志的纯净
  const tagline = level > 0 ? `\x1b[2m${BRAND_TAGLINE}\x1b[22m` : BRAND_TAGLINE;
  return colorizeBrandArt(art, level) + "\n" + tagline + "\n";
}
