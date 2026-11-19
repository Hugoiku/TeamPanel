# Graph Runtime v1（typed state / conditional edges / interrupt / checkpoint）

这是 Panel 的图运行时原型，不替换现有 Plan/WorkItem，用于验证下一阶段能力。

## 1. 能力

- typed state + reducer：节点只提交 patch，不整块覆盖；
- conditional edges：按状态条件选下一步；
- interrupt / resume：节点可暂停等用户决策；
- checkpoint：每一步落盘，可恢复；
- loop guards：步数/访问次数/边遍历/状态重复/时长上限；
- 子图：尚未实现，schema 预留。

## 2. 状态

默认 state：

```json
{
  "version": 1,
  "case": "...",
  "mission": {},
  "evidence": [],
  "claims": [],
  "needs": [],
  "metrics": {},
  "coverage": {},
  "artifacts": [],
  "gates": {},
  "decisions": {},
  "issues": [],
  "partial": false
}
```

reducer 规则：

- `evidence/provider/claims/needs/issues` 按 id 合并，不覆盖；
- `artifacts` 按 path 合并；
- `coverage/metrics/gates/decisions` 按对象合并；
- 未知字段直接赋值，但建议用命名空间。

## 3. 图定义

```json
{
  "id": "research-v1",
  "start": "fetch",
  "limits": {
    "maxSteps": 80,
    "maxVisitsPerNode": 20,
    "maxEdgeTraversals": 60,
    "maxRepeatedState": 3,
    "maxDurationMs": 1800000
  },
  "nodes": [
    { "id": "fetch", "type": "fetch" },
    { "id": "gate", "type": "gate" },
    { "id": "data", "type": "data" },
    { "id": "report", "type": "report" },
    { "id": "approval", "type": "approval" }
  ],
  "edges": [
    { "from": "fetch", "to": "gate" },
    { "from": "gate", "to": "report", "when": { "path": "coverage.ge.spot", "op": ">=", "value": 95 } },
    { "from": "gate", "to": "data", "default": true },
    { "from": "data", "to": "gate" },
    { "from": "report", "to": "approval" }
  ]
}
```

## 4. Interrupt / Resume

节点返回：

```js
{ interrupt: { prompt: "确认口径？", options: [{ id: "yes" }, { id: "no" }] } }
```

run 进入 `waiting` 并写 checkpoint。

恢复：

```js
resumeGraph(runId, { id: "yes" }, executors, { graph })
```

决策写入 `state.decisions[nodeId]`。

## 5. 防死循环

| Guard | 默认 | 作用 |
|---|---:|---|
| maxSteps | 80 | 总步数上限 |
| maxVisitsPerNode | 20 | 单节点重复上限 |
| maxEdgeTraversals | 60 | 单边重复上限 |
| maxRepeatedState | 3 | 连续状态 hash 相同则停止 |
| maxDurationMs | 30 分钟 | 墙钟超时 |

任一触发：

```text
GraphError code = MAX_STEPS / MAX_VISITS / MAX_EDGES / NO_PROGRESS / MAX_DURATION
run.status = failed
checkpoint 保留
```

## 6. 状态设计约束

- 状态字段必须版本化；
- 节点只能提交 patch；
- 数组元素必须有稳定 id 或 path；
- 不把大文件正文塞 state，只存路径/摘要/sha；
- 大对象放 artifact/cache，state 存引用；
- 每次 checkpoint 记录 state hash，便于回滚/对比。

## 7. 测试

```bash
node scripts/test-graph.js
```

覆盖：

- 条件循环收敛；
- interrupt/resume；
- MAX_VISITS / NO_PROGRESS；
- reducer 不覆盖；
- checkpoint 加载。
