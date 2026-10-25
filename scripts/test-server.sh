#!/usr/bin/env bash
# =============================================================================
# 多租户云端 Agent Server — API 一键测试脚本
#
# 用法：
#   bash scripts/test-server.sh                            # 烟雾测试（无需 LLM Key）
#   OPENAI_API_KEY=sk-... bash scripts/test-server.sh      # 完整链路（显式传入优先）
#                                                          # 未显式传入时，自动读取项目 .env 中的配置
#
# 可选环境变量（未设置时从项目 .env 读取）：
#   PORT                  监听端口（默认 8787；被占用时换一个，如 PORT=8790）
#   TENANT_API_KEY        演示租户 API Key（默认由脚本随机生成后注入）
#   MODEL                 LLM 模型（默认取 OPENAI_MODEL；都没有则不指定）
#   OPENAI_API_KEY        模型 API Key（设置后进入完整链路模式）
#   OPENAI_BASE_URL       模型端点（可选，默认官方）
#
# 脚本会启动一个独立的测试实例（临时 DATA_DIR + 短暂审批超时 8s），
# 测试完毕自动回收进程与临时数据，不影响已有服务。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# 清除沙箱/IDE 注入的调试器选项，避免每个 node 子进程输出调试噪音
export NODE_OPTIONS=

# 从项目 .env 加载配置（若存在）。已显式设置的环境变量优先，不覆盖
# （与 dotenv 的行为一致）。用 node 解析以正确处理引号/注释/空行。
if [ -f .env ]; then
  eval "$(node -e '
    const fs = require("fs");
    const out = [];
    for (const line of fs.readFileSync(".env", "utf-8").split("\n")) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      const key = m[1];
      if (process.env[key] !== undefined) continue; // 不覆盖已显式设置的
      let val = m[2].trim();
      if ((val.startsWith("\"") && val.endsWith("\"")) ||
          (val.startsWith("\u0027") && val.endsWith("\u0027"))) {
        val = val.slice(1, -1);
      }
      out.push("export " + key + "=" + JSON.stringify(val));
    }
    console.log(out.join("\n"));
  ')"
fi

PORT="${PORT:-8790}"
BASE_URL="http://127.0.0.1:${PORT}"
# 服务端默认已改为首启随机生成密钥；脚本需要知道密钥才能发请求，故这里显式注入一个临时值
API_KEY="${TENANT_API_KEY:-zk_test_$(node -e 'process.stdout.write(require("crypto").randomBytes(20).toString("hex"))')}"
# 不再回退某个具体型号：烟雾测试（无 Key）用不到模型；完整链路必须由调用方
# 明确指定，否则会拿一个本地根本没有的型号去请求，报错原因反而更难看清。
MODEL="${MODEL:-${OPENAI_MODEL:-}}"
APPROVAL_TIMEOUT_SECONDS=8
DATA_DIR="$(mktemp -d /tmp/zqagent-srv-test.XXXXXX)"
SERVER_PID=""
PASS=0
FAIL=0

# ---------- 工具函数 ----------
say()  { printf "\n== %s\n" "$*"; }
ok()   { PASS=$((PASS + 1)); printf "  [PASS] %s\n" "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf "  [FAIL] %s\n" "$*"; }

# check <名称> <期望状态码> <实际状态码>
check() {
  if [ "$3" = "$2" ]; then ok "$1 (HTTP $3)"; else bad "$1: 期望 HTTP $2，实际 HTTP $3"; fi
}

# jget <json> <路径...> — 用 node 提取 JSON 字段（无 jq 依赖）
jget() {
  node -e 'const j = JSON.parse(process.argv[1]); const p = process.argv.slice(2);
           console.log(p.reduce((o, k) => (o == null ? o : o[k]), j) ?? "")' "$@"
}

# code <curl 参数...> — 只返回 HTTP 状态码
code() {
  curl -s -o /dev/null -w "%{http_code}" "$@"
}

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

# ---------- 启动 Server ----------
say "启动 Server (端口 $PORT, 审批超时 ${APPROVAL_TIMEOUT_SECONDS}s)"

if curl -s -o /dev/null "$BASE_URL/healthz" 2>/dev/null; then
  echo "  ! 端口 $PORT 已有服务在运行（healthz 已响应）。"
  echo "  ! 为避免误操作已有实例，请换一个端口，例如：PORT=8790 bash scripts/test-server.sh"
  exit 1
fi

TENANT_ID=demo TENANT_API_KEY="$API_KEY" MODEL="$MODEL" \
PORT="$PORT" DATA_DIR="$DATA_DIR" APPROVAL_TIMEOUT_SECONDS="$APPROVAL_TIMEOUT_SECONDS" \
  npx tsx packages/core/src/server/index.ts >"$DATA_DIR/server.log" 2>&1 &
SERVER_PID=$!

ready=""
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "$BASE_URL/healthz" 2>/dev/null; then ready=1; break; fi
  sleep 0.5
done
if [ -z "$ready" ]; then
  echo "  ✗ Server 未在 30s 内就绪，日志如下："
  tail -20 "$DATA_DIR/server.log"
  exit 1
fi
ok "Server 就绪 (/healthz)"

# ---------- 1. 认证 ----------
say "1. 认证"
check "无 API Key → 401" 401 "$(code "$BASE_URL/api/v1/sessions")"
check "错误 API Key → 401" 401 "$(code -H "Authorization: Bearer wrong-key" "$BASE_URL/api/v1/sessions")"
check "正确 API Key → 200" 200 "$(code -H "Authorization: Bearer $API_KEY" "$BASE_URL/api/v1/sessions")"

# ---------- 2. 会话 CRUD ----------
say "2. 会话 CRUD"
check "创建会话 → 200" 200 "$(code -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -d '{}' "$BASE_URL/api/v1/sessions")"
CREATE_JSON="$(curl -s -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -d "{\"model\":\"$MODEL\"}" "$BASE_URL/api/v1/sessions")"
SID="$(jget "$CREATE_JSON" data sessionId)"
if [ -n "$SID" ]; then ok "会话 ID: $SID"; else bad "创建会话未返回 sessionId"; fi
check "获取会话详情 → 200" 200 "$(code -H "Authorization: Bearer $API_KEY" "$BASE_URL/api/v1/sessions/$SID")"
check "会话列表 → 200" 200 "$(code -H "Authorization: Bearer $API_KEY" "$BASE_URL/api/v1/sessions")"
check "不存在的会话 → 404" 404 "$(code -H "Authorization: Bearer $API_KEY" "$BASE_URL/api/v1/sessions/no-such-session")"
check "未知路由 → 404" 404 "$(code -H "Authorization: Bearer $API_KEY" "$BASE_URL/api/v1/whatever")"

# ---------- 3. 状态与事件 ----------
say "3. 状态与事件"
check "会话状态 → 200" 200 "$(code -H "Authorization: Bearer $API_KEY" "$BASE_URL/api/v1/sessions/$SID/state")"
check "事件轮询 → 200" 200 "$(code -H "Authorization: Bearer $API_KEY" "$BASE_URL/api/v1/sessions/$SID/events?since=0")"

# ---------- 4. 审批 / 提问 API（无挂起时） ----------
say "4. 审批 / 提问 API（无挂起交互时）"
check "审批列表（空）→ 200" 200 "$(code -H "Authorization: Bearer $API_KEY" "$BASE_URL/api/v1/sessions/$SID/approvals")"
check "回答不存在的审批 → 404" 404 "$(code -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -d '{"decision":"once"}' "$BASE_URL/api/v1/sessions/$SID/approvals/no-such")"
check "提问列表（空）→ 200" 200 "$(code -H "Authorization: Bearer $API_KEY" "$BASE_URL/api/v1/sessions/$SID/questions")"
check "回答不存在的提问 → 404" 404 "$(code -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -d '{"answer":"ok"}' "$BASE_URL/api/v1/sessions/$SID/questions/no-such")"

# ---------- 5. 跨租户隔离 ----------
say "5. 跨租户隔离"
mkdir -p "$DATA_DIR/tenants/t2"
printf '{"id":"t2","apiKey":"key2","model":"%s","provider":{"apiKey":"x"}}' "$MODEL" >"$DATA_DIR/tenants/t2/config.json"
check "租户 t2 的 Key 访问 t1 会话 → 404" 404 "$(code -H "Authorization: Bearer key2" "$BASE_URL/api/v1/sessions/$SID")"
check "租户 t2 独立创建会话 → 200" 200 "$(code -X POST -H "Authorization: Bearer key2" -H "Content-Type: application/json" -d '{}' "$BASE_URL/api/v1/sessions")"

# ---------- 6. 完整链路（需要真实 LLM Key） ----------
if [ -n "${OPENAI_API_KEY:-}" ]; then
  say "6. 完整链路：真实对话 → ask_user 提问挂起 → 超时回收 → 回答 → resume 恢复"

  check "提交 turn → 200" 200 "$(code -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -d '{"input":"请立即调用 ask_user 工具，向我提问一个问题，例如：是否需要继续执行？"}' "$BASE_URL/api/v1/sessions/$SID/turns")"

  # SSE 快速验证：turn 运行期间应能收到事件流
  SSE_OUT="$(curl -s -N --max-time 2 -H "Authorization: Bearer $API_KEY" -H "Accept: text/event-stream" "$BASE_URL/api/v1/sessions/$SID/events" 2>/dev/null | head -5 || true)"
  if printf '%s' "$SSE_OUT" | grep -q "event:"; then
    ok "SSE 事件流可用"
  else
    echo "  ⚠ SSE 在 2s 窗口内未捕获到事件（turn 可能已完成），跳过"
  fi

  # 轮询到 waiting_question（最多 60s；已完成/出错则提前退出）
  st=""
  for _ in $(seq 1 120); do
    st="$(jget "$(curl -s -H "Authorization: Bearer $API_KEY" "$BASE_URL/api/v1/sessions/$SID/state")" data status)"
    case "$st" in
      waiting_question | completed | error) break ;;
    esac
    sleep 0.5
  done

  if [ "$st" = "waiting_question" ]; then
    ok "引擎挂起等待提问 (status=$st)"
    QJSON="$(curl -s -H "Authorization: Bearer $API_KEY" "$BASE_URL/api/v1/sessions/$SID/questions")"
    QID="$(jget "$QJSON" data 0 id)"
    Q_TEXT="$(jget "$QJSON" data 0 question)"
    echo "  ➜ 收到提问: $Q_TEXT (id=$QID)"

    # 长时间不回答 → 超时回收：内存 run 释放，磁盘保持挂起点
    echo "  ➜ 等待 ${APPROVAL_TIMEOUT_SECONDS}s 触发超时回收（内存 run 释放，挂起点已持久化）..."
    sleep $((APPROVAL_TIMEOUT_SECONDS + 3))
    st="$(jget "$(curl -s -H "Authorization: Bearer $API_KEY" "$BASE_URL/api/v1/sessions/$SID/state")" data status)"
    if [ "$st" = "waiting_question" ]; then
      ok "回收后状态仍为 waiting_question（挂起点已在磁盘）"
    else
      bad "回收后状态异常: $st"
    fi

    # 用户回答 → 任务经 resume 恢复并完成
    check "回答提问 → 200" 200 "$(code -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -d '{"answer":"继续"}' "$BASE_URL/api/v1/sessions/$SID/questions/$QID")"
    done_st=""
    for _ in $(seq 1 120); do
      done_st="$(jget "$(curl -s -H "Authorization: Bearer $API_KEY" "$BASE_URL/api/v1/sessions/$SID/state")" data status)"
      case "$done_st" in
        completed | error) break ;;
      esac
      sleep 0.5
    done
    if [ "$done_st" = "completed" ]; then
      ok "回答后任务恢复并完成"
    else
      bad "任务未在预期时间内完成: $done_st"
    fi
  else
    echo "  ⚠ 模型未按指令调用 ask_user（状态=${st:-未知}），跳过交互链路演示。"
    echo "    可重试，或按 docs/server-api.md 手动演练审批/提问流程。"
  fi
else
  say "6. 完整链路（跳过：未设置 OPENAI_API_KEY）"
  echo "    设置 OPENAI_API_KEY 后运行，可演示：真实对话、ask_user 提问挂起、"
  echo "    超时回收（内存任务回收）与回答后 resume 恢复。"
fi

# ---------- 汇总 ----------
say "结果汇总: $PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ] || exit 1
