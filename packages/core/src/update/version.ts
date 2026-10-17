/**
 * 极简 semver 解析与比较（不引入 semver 依赖）。
 *
 * 只处理节点更新场景需要的子集：`major.minor.patch[-prerelease]`，
 * 允许前缀 `v`，忽略 build metadata（`+xxx`）。解析失败返回 null。
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** 预发布标识（`beta.1` → ["beta", 1]）；正式版为空数组 */
  pre: (string | number)[];
}

const PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(input: string): SemVer | null {
  const m = PATTERN.exec(input.trim());
  if (!m) return null;
  const pre = m[4]
    ? m[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : [];
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre,
  };
}

/** 比较预发布标识：数字段按数值比较，字符串按字典序，数字段低于字符串段 */
function comparePre(a: (string | number)[], b: (string | number)[]): number {
  // 无预发布标识 = 正式版，优先级高于任何预发布
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x < y ? -1 : 1;
    } else if (typeof x === "number") {
      return -1;
    } else if (typeof y === "number") {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** 返回 -1 / 0 / 1；任一版本无法解析时按「视为相同」返回 0（调用方需先校验） */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return 0;
  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;
  return comparePre(va.pre, vb.pre);
}

/** a 是否比 b 新 */
export function isNewer(a: string, b: string): boolean {
  return compareVersions(a, b) > 0;
}
