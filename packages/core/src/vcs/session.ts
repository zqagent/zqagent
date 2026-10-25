/**
 * 会话级变更追踪
 *
 * 每个会话一条 ref（`refs/agent/<sessionId>`），每轮一个提交。
 *
 * 提交内容的来源是「本轮结束时工作区的实际状态」——用 `git add -A` 拿快照，
 * 而不是从工具调用参数推断。原因：`run_shell` 可能用任意命令改文件，
 * 只有工作区快照才能覆盖全部改动。
 *
 * 锁的粒度：所有 git 操作共用一份 index，必须串行；但内部方法不能重复入队
 * （队列是先进先出，外层等内层、内层等外层会死锁）。因此拆成两套：
 * 公开方法 enqueue，内部实现带 `Unlocked` 后缀，只被队列内的代码调用。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  agentRef,
  sessionIndexPath,
  SHADOW_DIR,
  SHADOW_EXCLUDES,
  type TurnCommit,
  type VcsPlan,
} from "./plan.js";
import { gitOk, runGit } from "./runner.js";

/** 恢复结果 */
export interface RestoreResult {
  /** 实际写回的文件（工作区相对路径） */
  restored: string[];
  /** 写回前内容与快照不同的文件（即真正被改动覆盖的） */
  overwritten: string[];
  /** 该轮里没有该文件（被删除或路径写错） */
  missing: string[];
}

export class SessionVcs {
  private readonly ref: string;
  private readonly index: string;
  private readonly shadowDir: string;
  /**
   * 排除规则文件，通过 `-c core.excludesFile` 传给 git。
   *
   * 不用 pathspec `:(exclude).agent`：当 `.agent` 同时被忽略规则覆盖时，
   * git add 会直接报 "paths are ignored by one of your .gitignore files" 而失败。
   * 也不用仓库级 .gitignore：不能改用户的文件。
   */
  private readonly excludeFile: string;
  /** 串行队列：保证同一会话的 git 操作不并发 */
  private queue: Promise<unknown> = Promise.resolve();
  private readyOnce: Promise<boolean> | null = null;

  constructor(
    readonly plan: VcsPlan,
    readonly sessionId: string,
  ) {
    this.ref = agentRef(sessionId);
    this.index = sessionIndexPath(plan, sessionId);
    this.shadowDir = path.join(plan.workTree, SHADOW_DIR);
    this.excludeFile = path.join(plan.gitDir ?? this.shadowDir, "zqagent", "exclude");
  }

  get enabled(): boolean {
    return this.plan.mode !== "off" && this.plan.gitDir !== null;
  }

  /** 串行执行；失败不污染队列（否则一次失败会卡死后续操作） */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 初始化（幂等，必须在队列内调用）。
   *
   * shadow 模式要做两件事：建裸仓库、写 `info/exclude`。后者不能省：
   * 影子仓库的对象库就在工作区内的 `.agent/vcs`，不排除会把自己也提交进去。
   */
  private ensureReadyUnlocked(): Promise<boolean> {
    if (!this.enabled) return Promise.resolve(false);
    if (!this.readyOnce) {
      this.readyOnce = (async () => {
        if (this.plan.mode === "shadow") {
          if (!fs.existsSync(path.join(this.shadowDir, "HEAD"))) {
            // isolated：init 时不能带 GIT_WORK_TREE（git 会直接拒绝）
            const init = await runGit(
              this.plan,
              ["init", "--bare", "-q", this.shadowDir],
              { cwd: this.plan.workTree, isolated: true },
            );
            if (!gitOk(init)) return false;
          }
          const infoDir = path.join(this.shadowDir, "info");
          fs.mkdirSync(infoDir, { recursive: true });
          const excludeFile = path.join(infoDir, "exclude");
          const want = SHADOW_EXCLUDES.join("\n") + "\n";
          const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf-8") : "";
          if (!current.includes(".agent/")) fs.writeFileSync(excludeFile, current + want, "utf-8");
        }
        // index 所在目录必须存在（native 的 .git/zqagent/）
        fs.mkdirSync(path.dirname(this.index), { recursive: true });
        fs.mkdirSync(path.dirname(this.excludeFile), { recursive: true });
        fs.writeFileSync(this.excludeFile, SHADOW_EXCLUDES.join("\n") + "\n", "utf-8");
        return true;
      })();
    }
    return this.readyOnce;
  }

  /** 取当前 ref 指向的提交；还没有提交时返回 null */
  private async headCommitUnlocked(): Promise<string | null> {
    const r = await runGit(this.plan, ["rev-parse", "-q", "--verify", this.ref], {
      index: this.index,
    });
    return gitOk(r) ? r.stdout.trim() || null : null;
  }

  /**
   * 在本轮改动发生**之前**记一个基线。
   *
   * 没有基线时，首个快照是 root commit，会把工作区里所有已有文件都算作
   * 「本会话的改动」——多会话共享工作区时，A 会在自己的第一轮里看到 B 的文件，
   * `/changes` 的语义就错了。所以基线要在 turn 开始（工具执行前）建立，
   * 之后每个快照的 diff 才是该会话真实的改动。
   *
   * 幂等：已有 ref 就直接返回。
   */
  async beginTurn(): Promise<void> {
    if (!this.enabled) return;
    await this.enqueue(async () => {
      if (!(await this.ensureReadyUnlocked())) return;
      if (await this.headCommitUnlocked()) return;

      const add = await runGit(
        this.plan,
        ["-c", `core.excludesFile=${this.excludeFile}`, "add", "-A"],
        { index: this.index },
      );
      if (!gitOk(add)) return;
      const tree = await runGit(this.plan, ["write-tree"], { index: this.index });
      if (!gitOk(tree)) return;
      const treeSha = tree.stdout.trim();
      if (!treeSha) return;

      const message = `agent baseline\n\nsession: ${this.sessionId}\nts: ${new Date().toISOString()}`;
      const commit = await runGit(this.plan, ["commit-tree", treeSha, "-F", "-"], {
        index: this.index,
        input: message,
      });
      if (!gitOk(commit)) return;
      await runGit(this.plan, ["update-ref", this.ref, commit.stdout.trim()], {
        index: this.index,
      });
    });
  }

  /**
   * 记录本轮结束时的快照。
   *
   * 返回 null 表示「没有可提交的改动」或追踪未启用——纯问答的一轮不产生
   * 提交是正常的，不算错误。
   *
   * 不接受轮次编号：快照是按「有改动的轮次」顺序排列的，`listTurns()`
   * 返回的序号即快照序号。若把对话轮次也写进编号，两者会因空轮次而错位。
   */
  async commitTurn(status: string): Promise<TurnCommit | null> {
    if (!this.enabled) return null;
    return this.enqueue(async () => {
      if (!(await this.ensureReadyUnlocked())) return null;

      // core.excludesFile 保证影子仓库与工具结果目录不被提交；
      // native 模式下用户的 .gitignore 未必包含 .agent
      const add = await runGit(
        this.plan,
        ["-c", `core.excludesFile=${this.excludeFile}`, "add", "-A"],
        { index: this.index },
      );
      if (!gitOk(add)) return null;

      const tree = await runGit(this.plan, ["write-tree"], { index: this.index });
      if (!gitOk(tree)) return null;
      const treeSha = tree.stdout.trim();
      if (!treeSha) return null;

      const parent = await this.headCommitUnlocked();
      if (parent) {
        // 与上一轮 tree 相同说明本轮没有任何改动：不产生空提交，
        // 保持「turn 序号 ↔ commit」一一对应
        const prevTree = await runGit(this.plan, ["rev-parse", `${parent}^{tree}`], {
          index: this.index,
        });
        if (gitOk(prevTree) && prevTree.stdout.trim() === treeSha) return null;
      }

      const message = [
        `agent snapshot`,
        "",
        `session: ${this.sessionId}`,
        `status: ${status}`,
        `ts: ${new Date().toISOString()}`,
      ].join("\n");

      const args = ["commit-tree", treeSha, "-F", "-"];
      if (parent) args.push("-p", parent);
      const commit = await runGit(this.plan, args, { index: this.index, input: message });
      if (!gitOk(commit)) return null;
      const sha = commit.stdout.trim();

      const update = await runGit(
        this.plan,
        [
          "update-ref",
          this.ref,
          sha,
          ...(parent ? [parent] : ["0000000000000000000000000000000000000000"]),
        ],
        { index: this.index },
      );
      if (!gitOk(update)) {
        // CAS 失败说明有另一个进程在写同一条 ref：以最新为准，避免丢提交
        const forced = await runGit(this.plan, ["update-ref", this.ref, sha], {
          index: this.index,
        });
        if (!gitOk(forced)) return null;
      }

      const files = await this.filesOfUnlocked(sha);
      // turn 留 0：序号要遍历 ref 才知道（listTurns 负责），
      // 这里再怎么算都多一次 git 调用，而调用方通常只关心 commit 与 files
      return { turn: 0, commit: sha, ts: new Date().toISOString(), files, status };
    });
  }

  /** 某提交相对其 parent 改动/新增/删除的文件 */
  private async filesOfUnlocked(commit: string): Promise<string[]> {
    const r = await runGit(
      this.plan,
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", commit],
      { index: this.index },
    );
    if (!gitOk(r)) return [];
    return r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  /** 从提交消息里读回 status / ts（由 commitTurn 写入） */
  private async readMessageUnlocked(
    commit: string,
  ): Promise<{ status?: string; ts?: string; baseline?: boolean }> {
    const r = await runGit(this.plan, ["log", "-1", "--format=%B", commit], {
      index: this.index,
    });
    if (!gitOk(r)) return {};
    const status = /^status:\s*(.+)$/m.exec(r.stdout)?.[1]?.trim();
    const ts = /^ts:\s*(.+)$/m.exec(r.stdout)?.[1]?.trim();
    return {
      ...(status ? { status } : {}),
      ...(ts ? { ts } : {}),
      ...(/^agent baseline\s*$/m.test(r.stdout) ? { baseline: true } : {}),
    };
  }

  /** 列出本会话的全部轮次提交（从早到晚，turn 从 1 开始） */
  private async listTurnsUnlocked(): Promise<TurnCommit[]> {
    if (!(await this.ensureReadyUnlocked())) return [];
    if (!(await this.headCommitUnlocked())) return [];

    const list = await runGit(this.plan, ["rev-list", "--reverse", this.ref], {
      index: this.index,
    });
    if (!gitOk(list)) return [];
    const shas = list.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const out: TurnCommit[] = [];
    for (let i = 0; i < shas.length; i++) {
      const sha = shas[i]!;
      const meta = await this.readMessageUnlocked(sha);
      // 跳过基线提交：它不是「某一轮的改动」，列出来只会让 /changes 多一条噪音
      if (meta.baseline) continue;
      out.push({
        turn: out.length + 1,
        commit: sha,
        ts: meta.ts ?? "",
        files: await this.filesOfUnlocked(sha),
        status: meta.status ?? "",
      });
    }
    return out;
  }

  /** 公开：列出轮次 */
  async listTurns(): Promise<TurnCommit[]> {
    if (!this.enabled) return [];
    return this.enqueue(() => this.listTurnsUnlocked());
  }

  /** 某一轮的完整 patch（用于 /changes 展开查看） */
  async diffTurn(turn: number): Promise<string> {
    if (!this.enabled) return "";
    return this.enqueue(async () => {
      const turns = await this.listTurnsUnlocked();
      const target = turns[turn - 1];
      if (!target) return "";
      const r = await runGit(this.plan, ["show", "--format=", "--patch", target.commit], {
        index: this.index,
      });
      return gitOk(r) ? r.stdout : "";
    });
  }

  /** 读取某提交里某个文件的内容；不存在返回 null */
  private async fileAtUnlocked(commit: string, relPath: string): Promise<string | null> {
    const r = await runGit(this.plan, ["show", `${commit}:${relPath}`], { index: this.index });
    return gitOk(r) ? r.stdout : null;
  }

  /**
   * 把某一轮的文件恢复到工作区（按文件粒度）。
   *
   * 用途：某会话的改动被覆盖了，从它的快照里挑回需要的文件。
   * 语义是「恢复」，所以默认覆盖当前内容；会把「内容确实变了」的文件记入
   * `overwritten`，并支持 `dryRun` 先看会改动哪些文件。
   * 只做文件级恢复，不做行级合并——行级冲突交给人和 git。
   */
  async restoreTurn(
    turn: number,
    opts: { paths?: string[]; dryRun?: boolean } = {},
  ): Promise<RestoreResult> {
    const empty: RestoreResult = { restored: [], overwritten: [], missing: [] };
    if (!this.enabled) return empty;

    return this.enqueue(async () => {
      const turns = await this.listTurnsUnlocked();
      const target = turns[turn - 1];
      if (!target) return empty;

      const wanted = opts.paths?.length ? opts.paths : target.files;
      const result: RestoreResult = { restored: [], overwritten: [], missing: [] };

      for (const rel of wanted) {
        const content = await this.fileAtUnlocked(target.commit, rel);
        if (content === null) {
          result.missing.push(rel);
          continue;
        }
        const abs = path.join(this.plan.workTree, rel);
        const current = fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null;
        if (current === content) continue; // 已是目标内容，无需写
        if (current !== null) result.overwritten.push(rel);
        if (opts.dryRun) {
          result.restored.push(rel);
          continue;
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf-8");
        result.restored.push(rel);
      }
      return result;
    });
  }

  /** 丢掉本会话的追踪记录（不还原文件） */
  async forget(): Promise<boolean> {
    if (!this.enabled) return false;
    return this.enqueue(async () => {
      const r = await runGit(this.plan, ["update-ref", "-d", this.ref], { index: this.index });
      return gitOk(r) || /not a valid ref|no such ref/i.test(r.stderr);
    });
  }

  /** 等排队的操作全部完成（退出前调用，保证快照落盘） */
  async flush(): Promise<void> {
    await this.queue;
  }
}
