/**
 * 写冲突检测（乐观并发控制）
 *
 * 背景：多个会话共享同一个工作区时（server 配了 tenant.workspaceRoot），
 * 写工具全是「读 → 改 → 写」三步，中间没有任何保护。会话 A 写完，会话 B
 * 基于早先读到的旧内容再写一次，A 的改动就被静默覆盖了——没有报错，也没有痕迹。
 *
 * 这里用最轻的办法把冲突显式化：记住本会话**读到过**每个文件时的内容指纹，
 * 写入前再比一次。不一致说明期间有别人改过，直接拒绝并让模型重新读取。
 *
 * 刻意不做的事：
 * - 不加锁：加锁会让并行会话互相阻塞，与「同时进行」的目标相反；
 * - 不对没读过的文件做校验：那会把「新建文件 / 未读就覆盖」变成硬失败，
 *   属于行为变更，留待显式配置再启用。
 *
 * 因此：**只有本会话读过该文件时才有保护**。这覆盖了「两个会话都在改同一个
 * 文件」这一真正危险的场景，同时不改变其余路径的行为。
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";

/** 内容指纹（sha256 前 16 位，足够防碰撞且便于展示） */
export function contentDigest(content: string | null | undefined): string {
  if (content == null) return "";
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

/** 读文件并用当前内容算指纹；文件不存在返回 null */
function digestOfFile(absPath: string): string | null {
  try {
    return contentDigest(fs.readFileSync(absPath, "utf-8"));
  } catch {
    return null;
  }
}

export interface WriteConflict {
  /** 绝对路径 */
  path: string;
  /** 本会话读到的版本指纹 */
  expected: string;
  /** 磁盘上的当前指纹；文件已被删除时为 null */
  actual: string | null;
  /** 给模型看的错误消息（可直接作为工具返回值） */
  message: string;
}

/**
 * 会话级写冲突检测器。
 *
 * 一个会话一个实例；跨会话不共享状态，这正是「检测」而非「阻止」的前提：
 * 每个会话只知道**自己**读到过什么，因此在别人改动后写入会被发现。
 */
export class ConflictGuard {
  /** 绝对路径 → 本会话最近一次读到（或自己写入）的内容指纹 */
  private readonly digests = new Map<string, string>();

  /** 记录一次读取：后续写入将以这个版本为基准 */
  noteRead(absPath: string, content: string): void {
    this.digests.set(absPath, contentDigest(content));
  }

  /** 记录一次自己的写入：更新基准，避免同会话连续写触发误报 */
  noteWrite(absPath: string, content: string): void {
    this.digests.set(absPath, contentDigest(content));
  }

  /** 是否读过该文件（用于判断「有没有保护」） */
  hasRead(absPath: string): boolean {
    return this.digests.has(absPath);
  }

  /**
   * 写入前检查。
   *
   * 返回 null 表示可以写：
   * - 本会话没读过该文件（不保护，保持既有行为）；
   * - 或者磁盘内容与读到的版本一致。
   *
   * 返回冲突时调用方应放弃写入并把 message 交给模型，由它重新读取后重试。
   */
  checkWrite(absPath: string, displayPath: string): WriteConflict | null {
    const expected = this.digests.get(absPath);
    if (expected === undefined) return null;

    const actual = digestOfFile(absPath);
    if (actual === expected) return null;

    const cause =
      actual === null
        ? "文件已被删除"
        : "文件已被其他会话或进程修改";
    return {
      path: absPath,
      expected,
      actual,
      message:
        `${cause}：${displayPath}。请先用 read_file 重新读取，` +
        `基于最新内容再修改（避免覆盖别人的改动）。`,
    };
  }

  /** 清空记录（会话结束 / 测试用） */
  reset(): void {
    this.digests.clear();
  }
}
