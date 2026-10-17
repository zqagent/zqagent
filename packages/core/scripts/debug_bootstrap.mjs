/**
 * SEA 单文件产物的「启动引导」源码。
 *
 * tsup.sea.config.ts 会把导出的字符串作为 esbuild `banner` 注入到 bundle 顶部，
 * 因此它会在**任何模块代码之前**执行。为什么需要它：如果崩溃发生在 bundle 的
 * 模块初始化阶段（依赖在顶层就抛错），`src/cli/debug.ts` 里的处理器还没装上就
 * 已经退出了——这正是「Windows 上一闪而过、cmd 里也没有任何日志」的典型形态。
 *
 * 约束：
 * - 只依赖 Node 内置模块，且自身绝不抛出（外层 try/catch 兜底）。
 * - 日志路径规则必须与 src/cli/debug.ts 保持一致，后者通过 globalThis.__zqagentDebug
 *   复用这里建好的日志文件与计时基准（见 debug.ts 的 bootRef）。
 * - 保持为纯 JS 字符串：它跑在 bundle 之前，拿不到任何 TS/打包后的符号。
 */
export const DEBUG_BOOTSTRAP_JS = `
// === zqagent 启动引导（诊断模式，bundle 之前运行）===
(function () {
  try {
    var argv = process.argv || [];
    var env = process.env || {};
    var on =
      argv.indexOf("--debug") >= 0 || /^(1|true|yes|on)$/i.test(env.ZQAGENT_DEBUG || "");
    if (!on) return;

    var fs = require("node:fs");
    var os = require("node:os");
    var path = require("node:path");
    var file = env.ZQAGENT_DEBUG_LOG
      ? path.resolve(env.ZQAGENT_DEBUG_LOG)
      : path.join(
          env.ZQAGENT_DEBUG_DIR ? path.resolve(env.ZQAGENT_DEBUG_DIR) : os.tmpdir(),
          "zqagent-debug.log",
        );
    var t0 = Date.now();
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) {}
    try { fs.writeFileSync(file, ""); } catch (e) {}

    function w(text) {
      var line = "[+" + String(Date.now() - t0).padStart(6) + "ms] " + text;
      try { fs.appendFileSync(file, line + "\\n"); } catch (e) {}
      try { process.stderr.write(line + "\\n"); } catch (e) {}
    }

    globalThis.__zqagentDebug = { file: file, t0: t0, write: w };

    w("[boot] bundle 加载开始（模块尚未初始化）");
    w("[boot] exe=" + process.execPath);
    w("[boot] argv=" + JSON.stringify(argv));
    w("[boot] node=" + process.version + " " + process.platform + "/" + process.arch);
    w("[boot] 日志文件=" + file);

    process.on("uncaughtException", function (err) {
      w("[crash] uncaughtException\\n" + (err && err.stack ? err.name + ": " + err.message + "\\n" + err.stack : String(err)));
      process.exit(1);
    });
    process.on("unhandledRejection", function (reason) {
      w("[crash] unhandledRejection\\n" + (reason && reason.stack ? String(reason.stack) : String(reason)));
    });
    process.on("warning", function (war) {
      w("[warning] " + war.name + ": " + war.message);
    });
    process.on("exit", function (code) {
      w("[exit] 进程退出 code=" + code);
    });
  } catch (e) {
    // 引导本身失败绝不能阻断启动，只能尽力提示
    try { process.stderr.write("zqagent debug bootstrap failed: " + e + "\\n"); } catch (e2) {}
  }
})();
`;
