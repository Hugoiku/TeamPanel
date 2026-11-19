---
name: data-access
description: 取数规则与工具：优先新浪行情，其次 Tushare（token 在 runtime/secrets，禁止打印/提交），再次东财公开接口。所有数字必须带来源进 evidence/sources.jsonl，接口失败如实记录、不得用别的数字替代。
version: 1.0.0
---

# data-access · 取数

## 工具

```bash
node scripts/market quote --code 600519                  # 新浪实时行情（GBK，含 open/prev_close/price/high/low/date/time）
node scripts/market tsu --api daily --params '{"ts_code":"600519.SH","start_date":"20261001"}' --fields ts_code,trade_date,close,pct_chg
node scripts/market tsu --api stock_basic --params '{"ts_code":"600519.SH"}'
node scripts/market tsu --api income --params '{"ts_code":"600519.SH","start_date":"20240101"}'
node scripts/market cpi --limit 6                       # 东财 CPI（pmi / ppi 同理）
```

## 硬规则

1. **Tushare token 只在 `runtime/secrets/tushare.json`**（已 gitignore），脚本自己读，**任何输出/文件/提示词里都不许出现 token**；
2. 每个数字都要能指回来源：写进 `evidence/sources.jsonl`，字段 `{id, url|api+params, fetched_at, field, value, raw}`，正文引用 `[S#]`；
3. 接口失败：如实记录失败（url + 错误），**不得用别的接口/记忆里的数字替代**；能补的部分补，其余标「待补」；
4. 优先顺序：新浪（行情）→ Tushare（历史/财务，2600 积分够日线、基础信息、常见财务接口）→ 东财（宏观）；
5. 频率：同一接口连续调用不超过 1 次/秒；批量股票用 `params` 的 `ts_code` 逐个取，不要并发轰炸；
6. 只取与本轮任务相关的数据，不做全市场扫描。

## 证据池（追加写）

- 若 `evidence/sources.jsonl` 不存在：`desk acquire --path evidence/sources.jsonl --mode write` → `desk write --expected-version 0`；
- 已存在 vN：先 `desk cat` 读出、追加新行、`acquire` 后 `write --expected-version N`（不覆盖历史）；
- 每条尽量小：保留 `field` 与 `value` 即可，`raw` 只放必要字段，避免把整段 JSON 塞进去。

## 常见坑

- 东财 `push2` 行情接口时常 `curl(52)`，不要重试超过 2 次；行情优先用新浪；
- 新浪返回是 GBK，脚本已解码；直接 curl 会乱码；
- Tushare `daily` 返回的是**未复权**收盘价，写进底稿必须注明口径；
- 财务接口的 `end_date` 是报告期，不是抓取日。
