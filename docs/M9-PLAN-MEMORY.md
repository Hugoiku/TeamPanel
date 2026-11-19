# 计划 · 记忆 · 协作（v1 落地）

## 1. 每个员工自己的规划者

配置 `config/desk.json`：

```json
"models": {
  "planner": { "default": {"provider":"opencode-go","model":"deepseek-v4.1-flash"}, "byAgent": {} },
  "routes": { "fast": {...}, "strong": {...}, "verify": {...} }
},
"memory": { "checkpointPct": 0.8 },
"policy": { "planApprovalRoles": ["macro","industry","stock"] }
```

- `node scripts/planner.js --case <c> --agent <a>`：规划者产出 `plan.json`（模板；加 `--use-model` 调规划模型，失败回退模板）；
- 研究类（macro/industry/stock）计划进入「待审批」；审计/法律/交易自动通过；
- 面板左栏「计划 · 协作审批」：显示步骤摘要 + 批准并执行 / 退回；
- `node scripts/run-plan.js --case <c> --plan <PLx>`：逐步执行（同一 DSH 会话，按 tier 映射 provider/model）；`--dry-run` 只打印调用链。

## 2. 记忆索引 / 上下文防截断

- `node scripts/memory.js build --case <c>`：扫 vault + KB + evidence，生成 `runtime/memory/<case>/index.json`；
- `node scripts/memory.js search --case <c> --q "锗价 库存"`：关键词检索（文件/知识库/证据）；
- `node scripts/memory.js state|checkpoint --case <c> --agent <a>`：员工工作记忆 `runtime/memory/<case>/<agent>/state.json`；
- `run-plan` 累计 token，达到模型窗口 **80%** 时：写 state → `memory.checkpoint` 事件 → 开新会话继续后续步骤；
- 面板/账本可见 `memory.checkpoint` 事件。

## 3. 员工协作请求（B 模式）

- `POST /api/coordination {case,from,to,task,reason}` → 账本 `coordination.requested`，面板「计划 · 协作审批」出现「允许 / 拒绝」；
- `POST /api/coordination/decide` → `coordination.approved/denied`；批准后由 pipeline/panel 起对方员工会话（自动派发留作下一步）；
- 默认**不自动调用同事**；只有审批通过才执行。

## 4. 已改的文件

| 文件 | 内容 |
|---|---|
| `runtime/server/broker.js` | `/api/plan(s)`、`/api/plan/approve`、`/api/plan/progress`、`/api/coordination`(+decide)；`plan.*` / `coordination.*` 账本回放 |
| `runtime/agents/employee.js` | `--stage`、`--session-id`、`--save-session`、`--short-prompt`；步骤事件 `agent.step.started/finished`；输出 sessionId/usage |
| `scripts/planner.js` | 每员工规划者（模板 + 可选模型规划）→ 写入 Broker 计划 |
| `scripts/run-plan.js` | 审批计划逐步执行（同会话、tier→model、80% checkpoint） |
| `scripts/memory.js` | 索引 build/search、工作记忆 state、checkpoint |
| `dashboard/template.html` | 左栏「计划 · 协作审批」+ 批准/退回/允许/拒绝；员工列模型标签与模型事件（上一轮） |

## 5. 下一步

1. 真跑一轮 macro 的 PL1（8 步、同会话）：验证 `agent.step.*`、session 续跑、token 拆账、checkpoint 触发；
2. 计划编辑（面板改步骤/档位/删步）与 replan；
3. 协作批准后自动起对方员工会话，结果写回证据池并注入发起方下一步上下文；
4. 记忆 context pack 注入（每步 prompt 自动带 top-k 索引命中 + state 摘要），并在面板显示上下文占用。


### 环境自检与 Windows

- `GET /api/doctor`：Node / dsh（含版本）/ `config/desk.json` / 模型凭据 / vault 可写 / Python，返回 `{ok, checks[]}`；
- 面板顶部「环境未就绪」横幅列出必填项与修法，点「重新检查」刷新；健康时不显示（quiet by default）；
- Windows：`start.cmd` 启动；DSH 自动找 `dsh.cmd`；`extract.js` 用 `python`（可用 `PYTHON` 覆盖）；`PYTHONPATH` 分隔符用 `;`；员工 `dsh` 子进程在 Windows 上走 `shell:true`；
- 没有 DSH 时：面板可浏览账本/泳道/交付物、可审批计划，但员工真实运行需要 DSH + 模型凭据——这是已知边界，后续可加 demo 模式与执行器适配层。
