# RUNBOOK：卡住/失败/取消/恢复

## 1. 看健康

~~~
curl localhost:7801/api/watchdog
curl 'localhost:7801/api/work/stats?case=<case>'
curl 'localhost:7801/api/work?case=<case>'
~~~

## 2. 节点卡住

- 有心跳但任务慢：检查模型/工具调用；
- 无心跳：watchdog 会 requeue（最多 maxAttempts）或 failed；
- 租约过期：work.requeued，runner 会重新 claim。

## 3. 取消

~~~
curl -X POST localhost:7801/api/work/cancel -d '{"case":"<case>","id":"W1"}'
~~~

Runner 下一次心跳收到 cancelRequested 后终止子进程，节点变 cancelled。

## 4. 暂停/恢复

~~~
curl -X POST localhost:7801/api/work/pause -d '{"case":"<case>","paused":true}'
curl -X POST localhost:7801/api/work/pause -d '{"case":"<case>","paused":false}'
~~~

## 5. 失败重试

~~~
curl -X POST localhost:7801/api/work/retry -d '{"case":"<case>","id":"W1"}'
~~~

## 6. Broker 重启

- running 节点自动回队，cancelling 自动取消；
- 检查 work.orphaned 事件；
- Runner 重新执行 run-dag 即可继续。

## 7. 预算超限

- /api/work/stats 看 tokens；
- 配置 budgets.maxTokensPerCase，超限 claim 返回 budget 并写 budget.exceeded；
- 人工确认后提高预算或结束。

## 8. 清理

~~~
node scripts/cleanup.js --days 7 --dry-run
node scripts/cleanup.js --days 7
~~~
