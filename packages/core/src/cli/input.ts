/**
 * InputRouter — CLI 统一输入路由
 *
 * 将 readline 的 `line` 事件作为唯一输入通道,替代零散的 `rl.question`。
 * 按优先级把每一行输入路由到:
 *   1. 等待者(审批 / 提问 / 主循环命令)→ resolve 该行的 Promise;
 *      并发 ask(同轮多个交互工具)按先来后到排队,逐个显示提示符;
 *   2. 运行中的引擎(steering 目标)→ queueSteering(text) 作为补充信息;
 *   3. 无消费者 → 暂存,下一次 ask() 立即消费(防止运行结束瞬间的输入丢失)。
 *
 * 支持 suspend/resume:密码输入等需要独占 stdin 的场景期间忽略行事件。
 * ESC 双击中断不在本模块处理(仍由 cli/index.ts 的独立 data watcher 负责,
 * 因为它需要在 raw 字节层检测裸 ESC,而 readline 的 keypress 时机不可靠)。
 */
import type * as readline from "readline";

/** steering 目标最小接口(实际为 TurnEngine,解耦以便测试) */
export interface SteeringTarget {
  queueSteering(text: string): void;
}

/** 可写的输出目标(默认 process.stdout) */
export interface OutputTarget {
  write(s: string): void;
}

/**
 * 统计 chunk 中的裸 ESC 字节数。
 * 先剔除 CSI 序列(方向键 / Alt 组合等 `\x1b[...`),避免把功能键误判为 ESC。
 * 供 cli/index.ts 的 ESC 双击中断检测复用,便于单独测试。
 */
export function countRawEscapes(chunk: Buffer | string): number {
  const cleaned = chunk
    .toString()
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\x1bO[A-Za-z]/g, "");
  let escCount = 0;
  for (const ch of cleaned) if (ch === "\x1b") escCount++;
  return escCount;
}

/** readline 实例内部状态(未公开 API,供历史导航补丁访问) */
interface HistoryNavInterface {
  _ttyWrite: (s: string, key: unknown) => void;
  _moveCursor: (dx: number) => void;
  _refreshLine?: () => void;
  line: string;
  cursor: number;
  historyIndex: number;
}

/**
 * 修复 readline 的历史导航行为:
 * 1. 默认按上/下箭头时,readline 会把光标前的内容当作搜索前缀,导致
 *    「上箭头 → 移动光标 → 上箭头」时切不到更早的历史。这里在派发
 *    up/down 前把光标移到行首,使前缀为空,恢复为简单的历史导航
 *    (对齐 bash 默认行为)。
 * 2. readline 切换历史时直接覆盖当前行,且向下回到最底部时把行清空,
 *    正在输入的内容会丢失。这里在首次离开当前编辑行时记住草稿,向下
 *    切回最底部时恢复草稿及光标位置;提交一行后草稿失效。
 *
 * 注意:必须在 InputRouter 构造之后调用,使调用链为 历史导航 → 粘贴守卫 → 原生。
 */
export function patchReadlineHistoryNav(rl: readline.Interface): void {
  // readline 的 Symbol(_ttyWrite) / Symbol(_moveCursor) 只是 getter,代理到
  // 实例属性 _ttyWrite / _moveCursor,直接覆盖实例属性即可。
  const iface = rl as unknown as HistoryNavInterface;
  const orig = iface._ttyWrite;
  /** 进入历史导航前正在编辑的行;null 表示不在历史中(或已恢复/已提交) */
  let draft: { line: string; cursor: number } | null = null;

  iface._ttyWrite = function (s: string, key: unknown) {
    const k = key as TtyKey | undefined;
    const name = k?.name;
    const plainArrow =
      (name === "up" || name === "down") && !k?.ctrl && !k?.meta && !k?.shift;

    if (plainArrow) {
      // 首次按上键离开当前编辑行时记住草稿
      if (name === "up" && iface.historyIndex === -1) {
        draft = { line: iface.line, cursor: iface.cursor };
      }
      if (iface.cursor > 0) {
        iface._moveCursor(-iface.cursor);
      }
    }

    const prevHistoryIndex = iface.historyIndex;
    orig.call(rl, s, key);

    // 从历史项按下来回到底部时,readline 已把行清空,这里恢复草稿
    if (
      plainArrow &&
      name === "down" &&
      prevHistoryIndex >= 0 &&
      iface.historyIndex === -1
    ) {
      const saved = draft;
      draft = null;
      if (saved) {
        iface.line = saved.line;
        iface.cursor = Math.min(saved.cursor, saved.line.length);
        iface._refreshLine?.();
      }
    }
  };

  // 提交一行后草稿失效,避免下次历史导航恢复旧内容
  rl.on("line", () => {
    draft = null;
  });
}

export interface InputRouterOptions {
  rl: readline.Interface;
  stdout?: OutputTarget;
  /** 补充信息排队成功后的回调(用于打印确认) */
  onSteered?: (text: string) => void;
}

/** 排队等待一行输入的消费者(提示符 + resolve) */
interface PendingAsk {
  prompt: string;
  resolve: (line: string) => void;
}

/** readline 内部键事件的近似结构(未公开 API,供 _ttyWrite 拦截用) */
interface TtyKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/** 占位符中「粘贴文本」前缀,供还原时正则匹配 */
const PASTE_PLACEHOLDER_PREFIX = "粘贴文本 #";

export class InputRouter {
  private readonly rl: readline.Interface;
  private readonly stdout: OutputTarget;
  private readonly onSteered?: (text: string) => void;

  /** Tab 键回调(模式切换);为 null 时 Tab 透传原生处理 */
  private onTab: (() => void) | null = null;

  /** 当前正在等待一行输入的消费者(审批/提问/主循环) */
  private activeAsk: PendingAsk | null = null;
  /** 排队中的消费者:并发 ask 时逐个受理,避免后者覆盖前者的 waiter */
  private pendingAsks: PendingAsk[] = [];
  /** 无消费者时暂存的行,下次 ask 立即消费 */
  private queued: string[] = [];
  /** 运行中的引擎(steering 目标) */
  private steeringTarget: SteeringTarget | null = null;
  /** 挂起标记(密码输入等独占 stdin 场景) */
  private suspended = false;

  /** 是否处于 bracketed paste 粘贴态(ESC[200~ ... ESC[201~) */
  private pasting = false;
  /** 粘贴态下累积的原始文本 */
  private pasteBuf = "";
  /** 粘贴占位符序号(每次粘贴自增) */
  private pasteSeq = 0;
  /** 占位符序号 → 粘贴原文(保留以便历史重放时还原) */
  private readonly pasteStore = new Map<number, string>();
  /** readline 原生 _ttyWrite(非粘贴态透传) */
  private nativeTtyWrite: ((s: string, key: unknown) => void) | null = null;
  /** 安装的 _ttyWrite 包装(供 dispose 恢复) */
  private installedTtyWrite: ((s: string | undefined, key: unknown) => void) | null =
    null;

  constructor(opts: InputRouterOptions) {
    this.rl = opts.rl;
    this.stdout = opts.stdout ?? process.stdout;
    this.onSteered = opts.onSteered;
    this.rl.on("line", this._onLine);
    this.installPasteGuard();
  }

  /**
   * 拦截 readline 的 _ttyWrite,在 bracketed paste 期间捕获粘贴内容:
   * - paste-start 起进入粘贴态,吞掉后续所有按键(不调用原生,故不触发 line);
   * - 粘贴态内把字符/换行累积进 pasteBuf,换行归一化为 \n;
   * - paste-end 时:单行粘贴直接把原文插入输入行,多行则存入 pasteStore 并插入占位符;
   * - 非粘贴态完全透传原生 _ttyWrite(编辑/历史/提交行为不变)。
   *
   * 与 cli/index.ts 的 patchReadlineHistoryNav 层叠兼容:后者在之后包装,
   * 调用链为 history → 本包装 → native。
   */
  private installPasteGuard(): void {
    const iface = this.rl as unknown as {
      _ttyWrite?: (s: string, key: unknown) => void;
    };
    if (typeof iface._ttyWrite !== "function") return;

    this.nativeTtyWrite = iface._ttyWrite;
    this.installedTtyWrite = (s, key) => this.onTtyWrite(s, key);
    iface._ttyWrite = this.installedTtyWrite;
  }

  /** _ttyWrite 包装:粘贴状态机 + Tab 键拦截 */
  private onTtyWrite(s: string | undefined, key: unknown): void {
    const tk = key as TtyKey | undefined;
    const name = tk?.name;

    // 粘贴开始:进入粘贴态并清空缓冲
    if (name === "paste-start") {
      this.pasting = true;
      this.pasteBuf = "";
      return;
    }

    if (this.pasting) {
      // 粘贴结束:归一化并插入占位符
      if (name === "paste-end") {
        this.pasting = false;
        this.commitPaste();
        return;
      }
      // 粘贴中的换行(return / \r / \n)→ 累积为 \n,不提交
      if (name === "return" || s === "\r" || s === "\n") {
        this.pasteBuf += "\n";
        return;
      }
      // 粘贴中的普通字符 → 过滤控制字符(保留 \t)后累积
      if (typeof s === "string" && s.length > 0) {
        this.pasteBuf += s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
      }
      return;
    }

    // 非粘贴态:Tab → 模式切换(拦截,避免触发补全或插入制表符)
    if (name === "tab" && !tk?.ctrl && !tk?.meta && this.onTab) {
      this.onTab();
      return;
    }

    // 非粘贴态:透传原生处理
    this.nativeTtyWrite?.call(this.rl, s ?? "", key);
  }

  /** 粘贴结束:归一化换行;单行直接插入原文,多行折叠为占位符 */
  private commitPaste(): void {
    const text = this.pasteBuf.replace(/\r\n?/g, "\n");
    this.pasteBuf = "";
    if (!text) return; // 空粘贴不插入占位符

    const lineCount = text.split("\n").length;
    // 单行粘贴直接完整显示在输入框,便于继续编辑;多行才折叠显示行数
    if (lineCount === 1) {
      this.rl.write(text);
      return;
    }

    const id = ++this.pasteSeq;
    this.pasteStore.set(id, text);
    const placeholder = `[${PASTE_PLACEHOLDER_PREFIX}${id} ${lineCount}行]`;
    // rl.write 会再次进入 onTtyWrite,此时非粘贴态 → 透传原生,插入占位符
    this.rl.write(placeholder);
  }

  /** 把输入行中的占位符还原为粘贴原文(未匹配到序号则保留原样) */
  private restorePastes(line: string): string {
    return line.replace(
      new RegExp(`\\[${PASTE_PLACEHOLDER_PREFIX}(\\d+)[^\\]]*\\]`, "g"),
      (_m, n) => this.pasteStore.get(Number(n)) ?? _m,
    );
  }

  /**
   * 输出提示符,并把同一文本登记为 readline 的内部提示符。
   *
   * readline 重绘当前行(退格/删除/左右键等)时会先 `\r` + 清屏,再重写
   * 「内部提示符 + 当前行」。若不登记,内部提示符保持默认的 "> ",手写的
   * 提示符就会被清掉——表现为退格后 `[interactive][code] > ` 只剩 `> `。
   *
   * 含换行的提示符(主循环的 `\n[a][b] > `)只把最后一行交给 readline:
   * 否则每次重绘都会重复输出开头的换行,把当前行不断往下推。
   */
  private writePrompt(prompt: string): void {
    const nl = prompt.lastIndexOf("\n");
    if (nl >= 0) this.stdout.write(prompt.slice(0, nl + 1));
    const lastLine = nl >= 0 ? prompt.slice(nl + 1) : prompt;
    this.rl.setPrompt(lastLine);
    this.stdout.write(lastLine);
  }

  /** 询问一行:显示 prompt,返回该行内容 */
  ask(prompt: string): Promise<string> {
    return new Promise<string>((resolve) => {
      this.pendingAsks.push({ prompt, resolve });
      this.pumpAsks();
    });
  }

  /**
   * 逐个受理提问:同一时刻只显示一个提示符。
   *
   * 引擎会并发执行交互类工具(如同轮的 ask_user + request_directory),
   * 此时多个 ask 同时挂起。若提示符一起显示、等待者又只有一个槽位,
   * 后到的 ask 会覆盖先到的,用户回答只能唤醒其中之一,另一个永远挂起
   * (表现为「回答了没反应」)。因此这里排队,回答完一个再显示下一个。
   */
  private pumpAsks(): void {
    while (!this.activeAsk && this.pendingAsks.length > 0) {
      const item = this.pendingAsks.shift()!;
      this.writePrompt(item.prompt);
      // 无消费者期间暂存的行优先消费,不再等待新输入
      if (this.queued.length > 0) {
        item.resolve(this.queued.shift()!);
        continue;
      }
      this.activeAsk = item;
    }
  }

  /** 设置/清除运行中的 steering 目标 */
  setSteeringTarget(target: SteeringTarget | null): void {
    this.steeringTarget = target;
  }

  /**
   * 设置 Tab 键回调(如循环切换模式);传 null 恢复原生 Tab(补全)。
   * 回调触发时不会插入制表符,也不影响已输入的内容。
   */
  setTabHandler(handler: (() => void) | null): void {
    this.onTab = handler;
  }

  /** 当前提示符(readline 内部值),供模式切换等场景原地改写 */
  currentPrompt(): string {
    return this.rl.getPrompt();
  }

  /**
   * 原地重绘提示符,保留用户已输入的内容。
   * 只把最后一行交给 readline(与 writePrompt 的拆分规则一致),避免重复输出
   * 前导换行把当前行不断往下推。
   */
  refreshPrompt(prompt: string): void {
    const nl = prompt.lastIndexOf("\n");
    this.rl.setPrompt(nl >= 0 ? prompt.slice(nl + 1) : prompt);
    (this.rl as unknown as { _refreshLine?: () => void })._refreshLine?.();
  }

  /** 挂起(独占 stdin 期间忽略行事件) */
  suspend(): void {
    this.suspended = true;
  }

  /** 恢复 */
  resume(): void {
    this.suspended = false;
  }

  /** 移除监听并恢复 _ttyWrite(若仍指向我们的包装) */
  dispose(): void {
    this.rl.off("line", this._onLine);
    if (this.installedTtyWrite) {
      const iface = this.rl as unknown as {
        _ttyWrite?: (s: string, key: unknown) => void;
      };
      if (iface._ttyWrite === this.installedTtyWrite) {
        iface._ttyWrite = this.nativeTtyWrite ?? undefined;
      }
      this.installedTtyWrite = null;
    }
  }

  private readonly _onLine = (line: string): void => {
    if (this.suspended) return;

    // 先还原粘贴占位符(多行粘贴提交时恢复原文)
    const restored = this.restorePastes(line);

    // 1. 有等待者 → 作为回答/命令;随后受理下一个排队的提问
    if (this.activeAsk) {
      const w = this.activeAsk;
      this.activeAsk = null;
      w.resolve(restored);
      this.pumpAsks();
      return;
    }

    // 2. 运行中 → 作为补充信息(steering)
    if (this.steeringTarget) {
      const text = restored.trim();
      if (!text) return;
      this.steeringTarget.queueSteering(text);
      this.onSteered?.(text);
      return;
    }

    // 3. 无消费者 → 暂存,下次 ask 消费
    this.queued.push(restored);
  };
}
