# 双层 Agent Loop（2026-11 第一版）

> 目标：在现有 Broker/账本/门禁之上，加入 **Lead 编排循环 + Employee 领域循环**，让研究路径可以随证据生长，同时保留确定性约束与可审计性。
>
> 状态：P1-1 已完成 —— 普通 DAG 节点默认由 run-dag 调度、Employee Loop 执行，形成 claim → attach → gate → finish 的执行闭环。
>
> P1-2 已完成 —— case 预算预留/释放 + WorkItem 级 token 上限，超限 fail-closed。
>
> P1-3 已完成 —— 高风险动作使用结构化审批（need decision=approve/reject + 审批 token）。
>
> P1-4 已完成 —— trace 记录工具参数/结果，支持面板下钻与 loop 重放。
>
> P1-5 已完成 —— autonomy levels（workflow / supervised / autonomous）。
>
> modelChain 已完成接入 Employee Loop（逐阶段 skip-gate，最后阶段 gate）。

## 1. 两层

~~~text
Lead super-agent（case 级）
  ├─ 观察：case.snapshot / needs / plans / work / data.preflight / report.freshness
  ├─ 决策：start_plans / create_plan / revise_plan / assign_task / spawn_employee /
  │        request_review / cancel_task / ask_human / wait / synthesize / finish
  ├─ 编排：创建 WorkItem + Task Envelope，为 WorkItem 启动有界 Employee Loop
  └─ 产出：agent.loop.* 事件 + 人工待办；高风险动作走审批

Employee super-agent（WorkItem 任务级，有界）
  ├─ claim WorkItem（lease/fencing）；独立/Lead spawn 时 finish，DAG 由 scheduler 统一收口
  ├─ 读 Task Envelope / 上下文
  ├─ 多轮工具调用（desk / scripts / Broker API）
  ├─ 确定性输出门禁（employee-gate）：artifact / 产物 / 证据 / needs
  └─ 返回结果契约：status / artifacts / evidenceIds / openQuestions / needs / confidence

底层：Broker + Ledger + WorkItem + Gates + Tool Gateway
~~~

## 2. 运行模式

| 模式 | 行为 |
|---|---|
| fake | 不调用模型，只验证循环状态机/契约/账本；用于测试 |
| real | 每轮调用 Agent Runtime；默认 dsh，员工自己用工具干活，返回 JSON 契约 |

运行时适配层：scripts/agent-runtime.js

- dsh：调用 runtime/agents/employee.js（DSH headless 会话）；
- openai：OpenAI-compatible /chat/completions + function calling，工具走 Tool Gateway；
  - 需要在模型目录里配置 Base URL，或用 env override：
    AGENT_OPENAI_BASE_URL / AGENT_OPENAI_MODEL / AGENT_OPENAI_KEY / AGENT_OPENAI_HEADERS；
  - opencode-go 实测配置：
    base URL = https://opencode.ai/zen/go/v1
    model = deepseek-v4.1-flash
    header = x-opencode-session: <任意稳定值>
    key = OPENCODE_GO_API_KEY（~/.dsh/.credentials.yaml）；
  - 也可以在模型目录 catalog 条目里加 headers 对象（面板模型表单已支持 Headers JSON）。
  - 支持 tools/tool_calls 多步循环（最多 8 步）；
  - 高风险工具仍返回 pending_approval，不会自动放行；
  - 已用本地 mock OpenAI 网关验证 function calling + Tool Gateway 成功路径；
- fake：离线测试；
- 以后接 MCP / 其他 harness 时，只加 adapter，Loop/契约/账本/Tool Gateway 不变。

## 3. 启动方式

### Lead 循环

~~~bash
node scripts/lead-loop.js --case <c> --objective "完成 case 研究并产出可审阅报告" --mode real --max-rounds 4 --autonomy supervised
~~~

Lead 决策 JSON：

~~~json
{
  "action": "start_plans|create_plan|revise_plan|assign_task|spawn_employee|request_review|cancel_task|ask_human|wait|synthesize|finish",
  "planIds": ["PL1"],
  "plan": { "agent": "industry", "goal": "...", "steps": [] },
  "revise": { "planId": "PL1", "add": [], "update": [], "remove": [], "reason": "..." },
  "task": { "planId": "PL1", "nodeId": "S1", "agent": "industry", "task": "...",
            "outputs": ["research/x.md"], "depends": [], "maxTokens": 60000,
            "envelope": { "acceptance": ["..."], "tools": ["data.collect"],
                          "budget": { "maxTokens": 60000 } } },
  "spawn": { "workId": "W1", "agent": "industry", "runtime": "dsh", "mode": "real", "maxRounds": 3 },
  "review": { "title": "...", "detail": "..." },
  "cancel": { "workId": "W1", "reason": "..." },
  "need": { "kind": "info", "title": "...", "detail": "..." },
  "force": false,
  "reason": "为什么"
}
~~~

执行规则：

- create_plan：只建 **pending** 草稿，人工批准后才能运行；
- start_plans：只启动 **approved** 计划；
- revise_plan：修订计划；已批准计划被改动会自动撤销批准（plan.approval_revoked）；
- assign_task：创建 WorkItem + Task Envelope（DAG 执行单元）；
- spawn_employee：为一个 queued WorkItem 启动有界 Employee Loop；
- request_review：创建复核 need，循环转 waiting_human；
- cancel_task：高风险，需要「[取消审批]」need 的 `decision=approve`；未审批时只创建 need 并等待人工；
- ask_human：创建 info need，循环转 waiting_human；
- wait：等待运行中任务；
- synthesize：高风险，需要「[装配审批]」need 的 `decision=approve`；批准后下一轮只调用 report.assemble，**只装配、不签发**；
- finish：仍有活跃 WorkItem 时不会直接结束；force=true 仅用于测试/人工确认。

### Employee 循环

~~~bash
# 独立任务
node scripts/employee-loop.js --case <c> --agent industry --task "..." --mode real --max-rounds 3

# WorkItem 驱动（推荐）：claim -> 执行 -> finish
node scripts/employee-loop.js --case <c> --agent industry --work-id W1 --mode real --runtime dsh
~~~

WorkItem 驱动时：

- 先 GET /api/work/item 校验，再 POST /api/work/claim（带 loopId / leaseMs / resume）；
- lease 仍有效时拒绝第二个 worker；lease 过期后同 loop 可 resume；
- 运行中每 10–15 秒 heartbeat，收到 cancelRequested 或 lease 丢失会停止；
- 结束时 POST /api/work/finish，写入 outputs / gate / needsReview / loopId；
- Task Envelope 会注入员工提示词，声明产物必须真实存在；
- 调度器已 claim 时，用 `--attach --lease-id <id> --owner <dag> --no-finish` 接管执行：
  loop 只负责跑 agent + gate，WorkItem 的 finish 由 run-dag 在等完子任务/汇总后统一收口。

员工每轮回答最后返回结果契约：

~~~json
{
  "status": "continue|done|blocked",
  "summary": "...",
  "artifacts": ["research/industry.md"],
  "evidenceIds": ["S1"],
  "openQuestions": ["..."],
  "needs": [{ "kind": "data", "title": "...", "detail": "..." }],
  "confidence": 0.7
}
~~~

循环规则：

- status=done 或没有 openQuestions/needs → 结束；
- needs>0 或 blocked → waiting_human；
- continue 且还有轮次 → 下一轮注入上一轮契约；
- 超过 maxRounds → done_max_rounds；
- token/wall time 超预算 → budget_exceeded；
- 子代理：契约里的 subagents 只在 depth=0 时执行，最多 maxSubagents（默认 1），子循环 depth=1 不再派子代理。

确定性输出门禁（scripts/employee-gate.js）：

- 每次契约解析后先过 gate，结果写入 state.gate / agent.loop.gate；
- status=done 时强制检查：schema、artifacts 数组、artifact 文件存在、WorkItem 声明产物存在、evidenceIds 在 sources.jsonl 中存在、needs/openQuestions 为空、confidence 0–1；
- done 但门禁失败 → status=needs_review、contract_rejected，WorkItem finish 为 failed + needsReview，不会把“口头完成”传给 Lead；
- continue/blocked 只做 schema 检查，不要求产物已存在（允许下一轮继续）。

预算：

- 每循环记录 usage.tokens / toolCalls / subagents / wallMs；
- 每循环预算：maxTokens / maxWallMs / maxSubagents；
- case 总预算：GET /api/budget?case= 返回 tokens/limit/remaining；
  - 启动循环时超预算 → 409 budget_exceeded；
  - 每轮开始检查 case 预算，超了写 agent.loop.budget_exceeded 并停止；
- 事件 agent.loop.budget；
- 面板 Agent 循环卡片显示 token/预算、子代理数。

## 3.5 DAG 执行闭环（P1-1）

普通计划执行已默认切到 Employee Loop：

```text
run-dag claim WorkItem
  → employee-loop --attach --lease-id --no-finish
  → agent 执行 + 确定性 gate
  → run-dag 等子任务 / 汇总 / stage artifact
  → run-dag POST /api/work/finish（带 gate / loopId / needsReview）
```

配置与开关：

- `config/desk.json` → `scheduler.useAgentLoop: true`（默认开启）
- `scheduler.agentLoopRuntime` 默认 `dsh`，可改 `openai` / `fake`
- `node scripts/run-dag.js ... --no-agent-loop`：回退旧 `runtime/agents/employee.js` 路径
- `node scripts/run-dag.js ... --agent-loop`：即使 `--fake` 也强制走 loop（测试用）
- 带 `modelChain` 的节点逐阶段走 Employee Loop：中间阶段 `--skip-gate`，最后阶段执行完整 gate
- 节点支持 `waitForPlans`：跨计划等待上游 WorkItem 全部 done；stock 预研并行，估值/结论/风险/可视化等收口节点等 macro/industry
- 失败路径：loop gate 失败 → run-dag finish 为 failed + needsReview，stage artifact 记录 `loopId` / `employeeGate`
- 事件：`work.attached`、`agent.loop.*`、`stage.artifact`（含 loopId）

验收：

```bash
node scripts/test-dag-loop.js
```

## 3.6 预算闭环（P1-2）

预算分三层：

| 层级 | 机制 |
|---|---|
| case 总预算 | `budgets.maxTokensPerCase`；`0` 表示不限额 |
| case 预留 | claim 前按 WorkItem `maxTokens`（或 `defaultWorkReserve`）占位，finish/cancel/retry/watchdog 释放 |
| WorkItem 预算 | `maxTokens`；实际 token 超限 → finish 失败 + `needsReview` |

规则：

- `maxTokensPerCase > 0` 时，新 claim 要求 `tokens + reserved + reserveAmount <= limit`，否则返回 `reason: "budget"`；
- 预留只是上限占位，`agent.usage` 仍按实际 token 累计到 `caseTokens`；
- 预留有 TTL（`budgets.reservationTtlMs`，默认 30 分钟），过期自动释放并写 `budget.reservation_expired`；
- finish/cancel/retry/暂停恢复/watchdog requeue 都会释放预留，避免“崩溃后预算永久占住”；
- `agent.usage` 对 openai runtime 由 employee-loop 补写；dsh 仍由 employee.js 自己写，避免重复计数；
- 事件：`budget.reserved` / `budget.committed` / `budget.released` / `budget.overspent` / `budget.work_exceeded` / `budget.reservation_expired`。

API：

~~~bash
GET  /api/budget?case=            # tokens/reserved/available/limit/reservations
POST /api/budget/reserve          # {case, amount, workId, loopId, owner}
POST /api/budget/release          # {reservationId, actualTokens, reason}
~~~

面板：

- 任务列表 WorkItem 行显示 `token 实际/上限`；
- Agent 循环卡片显示循环 token / 循环预算；
- case 预算仍可在配置中设置；默认 `0` 不限额，设置后才会拦截新任务。

验收：

~~~bash
node scripts/test-budget-reservation.js
~~~

### 3.6.1 执行预算与失败语义（2026-11 补）

WorkItem 现在同时有 **token 预算** 和 **wall time 预算**：

| 字段 | 位置 | 默认 |
|---|---|---|
| `maxTokens` | WorkItem / envelope.budget | 0（不限额） |
| `maxWallMs` | WorkItem / envelope.budget | fast 10min / strong 45min / verify 45min |
| `leaseMs` | `config/desk.json` scheduler | 180s |
| `workHeartbeatMs` | watchdog | 180s |

- run-dag 把 `maxWallMs` 和 `leaseMs` 传给 employee-loop；
- employee-loop 超 wall time 时写 `wall_time_exceeded`，不再只报 `employee run failed`；
- WorkItem finish 写 `failureKind`：`wall_timeout / heartbeat_timeout / artifact_missing / citation_missing / budget_exceeded / employee_failed`；
- `/api/work/retry` 会重置 `cancelRequested / progressStalled / partial / failureKind`，避免“重试后立即又被取消”；
- `/api/work/contract` 可更新 `outputs / maxWallMs / maxTokens`，用于修正旧 WorkItem 契约；
- 重启回放保留 WorkItem 的 `outputs / maxWallMs`，空 outputs 不覆盖已有契约。

## 3.7 结构化审批（P1-3）

高风险动作不再从自然语言猜“是否批准”：

- need 答复支持 `decision: "approve" | "reject"`；
- 只有 `status=answered` + `decision=approve`（且不是 waived）才算批准；
- 旧 need 没有 decision 时才回退到文本拒绝关键词判断；
- 审批通过并被实际使用后，Lead 调用 `/api/need/consume` 写入 `consumedAt`，同一审批不能被重复复用；
- Tool Gateway 的 `task.cancel` / `report.assemble` 标记 `requiresApprovalToken`，必须带 `approvalToken: "need:<needId>"`；
- Tool Gateway 会回查 `/api/needs`，校验 need 已 answered、decision=approve、标题前缀匹配（`[取消审批]` / `[装配审批]`）；
- 没有 token 或 token 无效 → `pending_approval`，Lead 创建审批 need 并转 waiting_human；
- 面板的审批 need 显示「批准 / 拒绝」按钮，直接写结构化 decision。

API：

~~~bash
POST /api/need/answer   # {case, id, decision: "approve"|"reject", answer, by}
~~~

事件：

- `need.decided`（含 decision）
- `need.answered`（含 decision）
- `tool.pending_approval`（含 tokenPresent / tokenOk）

验收：

~~~bash
node scripts/test-lead-actions.js   # 含 approve -> 真取消、reject -> 不执行
~~~

## 3.8 Trace 下钻与重放（P1-4）

- `runtime/agents/employee.js` 记录 DSH 的 `tool_call.input` 与 `tool_result.result`（截断）；
- `scripts/agent-runtime.js` 的 openai adapter 记录 function calling 的 args / result / status；
- `employee-loop` 把每个工具调用写成 trace：`{name, callId, status, input, result}`；
- 面板 Agent 循环卡片可展开 `trace N`，查看最近 30 条 trace；
- 已结束的 loop 提供「重放」按钮，`POST /api/agent/loop/replay` 用原参数创建新 loop，新 loop 记录 `replayOf`；
- 事件：`agent.loop.replayed`。

~~~bash
POST /api/agent/loop/replay   # {case, id, by}
~~~

## 3.9 Autonomy levels（P1-5）

配置：

~~~json
"autonomy": { "mode": "supervised" }
~~~

| 模式 | 允许的 Lead 动作 |
|---|---|
| workflow | start_plans / ask_human / wait / finish |
| supervised（默认） | 全部动作；高风险动作仍需人工审批 |
| autonomous | 全部动作；高风险动作仍需人工审批（保留确定性安全边界） |

- Lead loop 读取 `--autonomy` 或 `config/desk.json`；
- 不允许的动作会被确定性拦截：`agent.loop.blocked_by_autonomy`，状态转 `waiting_human`；
- 面板启动 Lead 循环时可选择 autonomy，卡片显示当前级别。

## 4. Tool Gateway

~~~bash
GET  /api/tools                 # 工具目录 + JSON Schema
POST /api/tools/<name>          # 统一调用
~~~

已暴露工具：

- case.snapshot / case.needs / case.plans / case.work
- data.preflight / data.source_health / data.jobs / data.collect
- need.request
- plan.start（high risk）
- plan.create / plan.revise（只建 pending；改动已批准计划会撤销批准）
- work.create（WorkItem + Task Envelope）
- employee.spawn（为 WorkItem 启动有界 Employee Loop）
- task.cancel（high risk；需要 [取消审批] approve token）
- report.assemble（high risk；需要 [装配审批] approve token；只装配、不签发）
- report.freshness
- web.site（抓网址+统计子页+XLS/PDF，返回 bundle 供模型识别数据）
- web.agent（通用网页解析 Agent：URL + 目标板块，模型自主点 tab/跟链接/下载附件）
- memory.search

规则：

- 只暴露领域工具，不暴露裸 bash/write；
- 高风险工具默认返回 pending_approval，需 approved:true；
- 写操作有 10 分钟幂等缓存；
- 每次调用写 tool.called / tool.result / tool.failed 账本事件（参数只记 hash）。

## 4.5 MCP Server（当前暂停接入）

> 按用户要求，MCP 暂时放一边；代码保留，先不接入运行链路。

scripts/mcp-server.js 把 Tool Gateway 暴露为 MCP stdio server：

~~~bash
node scripts/mcp-server.js
~~~

支持：

- initialize
- tools/list
- tools/call
- ping

工具名里的点映射为双下划线（case.snapshot -> case__snapshot），调用时再映射回来。
任何支持 MCP 的 Agent runtime 都可以接入；执行仍走 Tool Gateway 的权限/幂等/审计。

## 5. Broker API / 事件

| 接口 | 作用 |
|---|---|
| POST /api/agent/loop | 启动 Lead/Employee 循环（后台进程） |
| GET /api/agent/loops?case= | 列出循环状态 |
| GET /api/agent/loop?id= | 单个循环详情 |
| POST /api/agent/loop/stop | 请求停止（写 .stop 文件） |

事件：

- agent.loop.queued
- agent.loop.started
- agent.loop.round.started
- agent.loop.decision / agent.loop.reflect
- agent.loop.action（Lead 每个动作的结果）
- agent.loop.gate / agent.loop.contract_rejected
- agent.loop.work.finished（WorkItem finish 结果）
- agent.loop.synthesized（只装配、不签发）
- agent.loop.escalated
- agent.loop.finished / agent.loop.failed
- work.attached / work.resumed / work.finished / work.failed
- need.decided（结构化审批 approve/reject）/ need.consumed
- agent.loop.replayed / agent.loop.blocked_by_autonomy
- tool.called / tool.result / tool.failed / tool.pending_approval

状态文件：runtime/agent-loops/<loopId>.json，含 status/rounds/trace/decision/actions/contract/gate/workId。

## 6. 面板

右栏「Agent 循环」手风琴：

- 启动 Lead 循环 / 启动员工循环；
- 启动员工循环时可填 WorkItem ID，由 WorkItem 驱动 claim/finish；
- 显示状态、轮次、workId、门禁结果、最近 trace、decision/contract 摘要；
- 任务列表的 WorkItem 行显示 loopId 与门禁✓/✗；
- 运行中可停止；
- 每 5 秒刷新一次（仅手风琴展开时）。

## 7. 验收

~~~bash
node scripts/test-agent-loop.js
node scripts/test-workitem-loop.js    # WorkItem claim/finish + 输出门禁失败路径
node scripts/test-lead-actions.js     # Lead 扩展动作 + 审批边界
node scripts/test-dag-loop.js         # run-dag → Employee Loop → gate → finish
node scripts/test-budget-reservation.js # 预算预留/释放/超限 fail-closed（独立临时 broker）
node scripts/test-openai-runtime.js   # 本地 mock OpenAI 网关 + function calling
node scripts/test-openai-opencode.js  # 真实 opencode-go 网关 + function calling
node scripts/test-mcp-server.js       # MCP initialize/tools/list/tools/call（当前暂停接入）
~~~

覆盖：

- 契约解析；
- Agent Runtime 适配层（dsh/openai/fake）；
- Tool Gateway 目录与高风险拦截；
- Employee/Lead fake 循环状态机、子代理 depth<=1；
- WorkItem claim -> gate -> finish；产物缺失时 contract_rejected + needsReview；
- run-dag 节点 attach 到 Employee Loop，gate 通过后由 scheduler finish；失败挂 needsReview；--no-agent-loop 回退旧路径；
- Lead create_plan / revise_plan（撤销批准）/ assign_task / spawn_employee / request_review / cancel_task / synthesize（不签发）；
- 结构化审批 approve -> 真取消；reject -> 不执行且保持等待；审批使用后 consumedAt 防复用；
- autonomy=workflow 确定性拦截 create_plan；
- loop replay 创建新 loop 并记录 replayOf；
- modelChain 逐阶段走 Employee Loop，中间阶段 skip-gate；
- Broker 启动循环 / 列表 / 工具调用 / case 预算接口。

真实模型冒烟（需要模型配置）：

~~~bash
node scripts/employee-loop.js --case <c> --agent industry --task "..." --mode real --max-rounds 1
node scripts/lead-loop.js --case <c> --objective "..." --mode real --max-rounds 1
~~~

## 8. 当前边界（下一步）

- Lead 的 synthesize 需要人工审批（[装配审批] need + decision=approve）；批准后只调用 report.assemble，不自动签发；
- cancel_task 同样需要人工审批（[取消审批] need + decision=approve + approvalToken）；
- 审批通过后如何再次触发同一动作：下一轮 Lead 观察到 answered need 后自动执行；token 校验由 Tool Gateway 回查 need，不信任调用方自报；
- Employee 子代理已支持 depth ≤1、最多 1 个；更深递归仍禁止；
- 预算已覆盖“每循环 + case 预留 + WorkItem maxTokens”；`maxTokensPerCase` 默认 0（不限额），需要显式设置后才会拦截新任务；
- 普通计划已默认由 run-dag + Employee Loop 执行（P1-1）；modelChain 已逐阶段接入 loop；
- 执行闭环已覆盖 claim / attach / heartbeat / gate / finish / needsReview / stage artifact / 预算预留与释放；
- Agent trace 已记录工具参数/结果，但为保证状态文件体积做了截断；完整大结果仍在 agent-runs / ledger 里；
- loop replay 是“用原参数重跑”，不是事件级逐步回放；事件级回放仍依赖 ledger；
- autonomy=autonomous 仍保留高风险动作的人工审批，未做完全无人审批；
- OpenAI-compatible function calling 已用 mock 网关 + 真实 opencode-go 网关验证；其他网关仍需配置 Base URL/header；
- MCP server 已实现（initialize/tools/list/tools/call），但还没在 DSH/第三方 MCP client 里做真实接入；
- 真实模型偶发不返回 JSON 契约时，employee-loop 会按低置信 done 兜底并写 contract_fallback 事件。

## 9. 设计约束

- 双层都可以自主，但都不能绕过 Broker/门禁；
- 上层 Lead 只启动 approved 计划，不替人签发；
- 下层 Employee 可以提 need/blocked，但不能改 case 计划；
- 所有循环状态可回放，失败可停可重试。
