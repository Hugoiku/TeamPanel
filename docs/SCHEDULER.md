# 调度器与 Worker 协议（Stage 0–5）

## 组件

| 组件 | 文件/接口 | 职责 |
|---|---|---|
| WorkItem | runtime/server/broker.js /api/work* | DAG 节点状态、租约、取消、重试、回放 |
| Runner | scripts/run-dag.js | 校验 DAG、创建节点、claim、执行、心跳、finish |
| Watchdog | broker 内置 2s pass | 心跳/超时/重试/暂停/告警 |
| Router | scripts/run-dag.js + config/workers.json | 按 capability/agent 选择 worker |
| Worker | DSH employee 会话 | 执行单节点任务 |
| Stats | /api/work/stats | 节点、重试、耗时、token、预算 |

## WorkItem 状态

~~~
queued → running → done / failed
       ↘ cancelled
running → cancelling → cancelled
running → requeued（watchdog 心跳超时）
~~~

- claim 生成 leaseId，heartbeat/finish 校验 owner+leaseId+租约；
- retryAfter 退避；attempt 记录次数；
- 重启时 running → queued，写 work.orphaned；cancelling → cancelled。

## 常用命令

~~~
node scripts/run-dag.js --case c --plan PL1 --dry-run
node scripts/run-dag.js --case c --plan PL1
node scripts/run-dag.js --case c --plan PL1 --max-concurrency 2
node scripts/run-dag.js --case c --plan PL1 --fake --fake-ms 500 --max-concurrency 2

curl -X POST localhost:7801/api/work/pause -d '{"case":"c","paused":true}'
curl -X POST localhost:7801/api/work/retry -d '{"case":"c","id":"W12"}'
curl -X POST localhost:7801/api/work/cancel -d '{"case":"c","id":"W12"}'
curl 'localhost:7801/api/work/stats?case=c'
~~~

## 并发/合并规则

- 默认串行；--max-concurrency N 只并发“依赖已满足”的节点；
- 同一输出路径的并发节点会被判冲突（work.conflict），merge 节点可豁免；
- 每个节点工作区：runtime/work/<workId>/；
- merge_from 的节点会自动追加依赖，任务提示里标注“合并节点”。

## 配置

~~~
{
  "scheduler": { "maxConcurrency": 1, "leaseMs": 120000, "heartbeatMs": 15000, "conflictCheck": true },
  "watchdog": { "enabled": true, "workHeartbeatMs": 60000, "maxAttempts": 3, "backoffMs": 5000, "pauseOnExhausted": false },
  "budgets": { "maxTokensPerCase": 0 },
  "features": { "simpleMode": true, "concurrency": true, "router": true, "watchdogActions": true }
}
~~~

## 生产建议

- 先串行跑通再开并发；
- 并发上限 ≤ 2，只对独立取数/分项分析开启；
- 每节点必须有唯一输出或写临时工作区；
- 预算/超时/重试上限先配好；
- 用 cleanup.js 定期清工作区/缓存。
