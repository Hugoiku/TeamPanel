# 锁抖动复盘：交易员为什么频繁释放锁

case-2026-001 · 2026-10-29 16:04–16:07 · 账本 runtime/ledger/events.jsonl

## 1. 结论

不是 bug，是协议和派活提示词一起把「读一个文件」定义成了「加一次读锁 → 看一眼 → 马上释放」。
交易员读了 6 个文件却产生了 8 次读锁、2 次写锁，一轮 209 秒里 20 条事件是锁事件（共 25 条）。

## 2. 账本证据（10 次加锁 / 释放配对）

| 锁 | 模式 | 持锁 | 路径 | 用途 |
|---|---|---|---|---|
| L26 | R | 3978ms | research/stock.md | 首次通读（含思考时间，持锁太久） |
| L27 | R | 72ms | review/audit.json | 读审计结论 |
| L28 | R | 70ms | review/legal.json | 读法律结论 |
| L29 | R | 71ms | research/stock.json | 读结构化底稿 |
| L30 | R | 69ms | research/stock.md | 重复读第 2 次 |
| L31 | R | 74ms | research/stock.json | 重复读第 2 次 |
| L32 | W | 73ms | trade/plan.md | 写交易计划 |
| L33 | W | 77ms | trade/plan.json | 写结构化计划 |
| L34 | R | 76ms | trade/plan.md | 写完回读自检 |
| L35 | R | 69ms | trade/plan.json | 写完回读自检 |

合计持锁 4.6 秒（占 209 秒的 2.1%）。时间成本不大，真正的成本是：
读锁在持锁期间挡住后面的写者（本 Broker 写优先），以及面板上 20/25 条事件都是「获得锁/释放锁」的噪声。

## 3. 三条原因

1. **派活提示词写死了加锁读**：我给交易员的 spawn 提示是「每个文件 acquire --mode read → peek → release」，于是 6 个文件 = 6 次加解锁。
2. **协议没有读取分级**：agents/_COMMON.md 1.0.0 只讲 acquire/read，没写「只是看一眼内容可以用不加锁的 peek」。
3. **没有批量/事务原语**：一次只能锁一个文件，也不允许写完直接信 write 的返回，所以出现「写完回读自检」。

## 4. 已修（协议 1.1.0）

- agents/_COMMON.md 新增读取分级表：peek / cat（不加锁，默认）vs read（只在需要冻结版本、要写回时加读锁）；
- 新增硬规则 6：写完不必回读自检，write 返回里有 version + sha，一次 desk status 能看全部版本；
- scripts/desk 增加 cat（等同于 peek），用法串同步更新；
- 明确「能 peek 就不要 read；一个文件不要反复加解锁」。

## 5. 预期与遗留

- 预期：下一轮交易员锁事件从 20 条降到 ≤6 条（2 次写锁 + 最多 2 次冻结版本读锁）。
- 遗留：desk txn（一次锁多个文件）未做；面板锁事件折叠未做；写了但没改的读回来自检只能靠协议约束，Broker 不会拦。
