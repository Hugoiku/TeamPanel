# DataTask：数据补齐专用任务

> 目标：把“缺数据 → 找来源 → 解析 → 逐项验收 → 用户确认 → 写入工作流”做成一个有界、可审计、可重放的专用任务，而不是让模型在对话框里自由发挥。

## 1. 设计原则

**智能**：模型可以在允许的动作空间内自主选择来源、翻页、找附件、提取字段、判断还缺什么、建议下一步。

**边界**：

- 只能处理指定 case + need + itemIndexes；
- 只能访问 Policy 允许的来源；
- 只能调用白名单工具；
- 只能在预算内运行；
- 模型不能自己验收、不能自己写证据、不能自己关闭缺口；
- 用户确认后才事务写入。

一句话：**模型提议，Policy 允许，Tools 执行，Gate 校验，Human 确认，Writer 提交。**

## 2. 总体架构

~~~text
N325 缺口
  → 创建 DataTask（need/items/来源/策略）
  → DataContract（字段/单位/频率/区间/验收规则）
  → Policy（来源/工具/预算/安全）
  → SourcePlan（URL/文件 → 预期覆盖项）
  → Attempt Loop（web.agent / 文件表格解析）
  → Coverage + Quality Gate（逐项）
  → ready_for_review
  → 用户确认
  → 事务写入 evidence / metric / need item
  → need 关闭，报告 stale
~~~

## 3. 状态机

任务级：

~~~text
source_pending   待补来源
ready            可开始
parsing          解析中
needs_more       还缺数据（未到最大尝试次数）
needs_human      尝试耗尽 / 登录 / 反爬 / 冲突，需要人工
ready_for_review 门禁通过，等用户确认
confirmed        已确认（短暂）
writing          写入中
closed           已关闭
cancelled        已取消
failed           失败
~~~

每个缺口项有独立状态：pending → candidate_found → provided / waived，支持只重跑失败项。

## 4. DataContract

从 need 的 spec.items 生成，是模型提取和 Gate 验收的共同锚点：

~~~json
{
  "index": 0,
  "indicator": "招商银行H股前复权收盘价",
  "definition": "03968.HK 日频前复权收盘价",
  "unit": "港元",
  "frequency": "日",
  "range": "2021-01-01至2026-11-17",
  "format": "CSV: date,close_adj_hkd",
  "requiredFields": ["value", "unit", "period", "sourceUrl"],
  "expected": 1500,
  "periodType": "daily",
  "acceptance": { "minCoverage": 0.98, "maxGap": 5, "maxAgeDays": 7 }
}
~~~

默认验收规则按频率：

| 频率 | 最低覆盖 | 允许最大滞后 |
|---|---|---|
| 日 | 98% | 7 天（expected 按每年约 242 个交易日估算） |
| 月 | 95% | 45 天 |
| 季 | 100% | 120 天 |
| 年/事件 | 100% | 400 天 |
| 文本 | 1 条 | 3650 天 |

**90% 只做进度和“进入确认”的软阈值，不做自动完成阈值。**

## 5. SourcePolicy

创建任务时固定，执行前再次检查：

~~~json
{
  "maxAttempts": 3,
  "maxSteps": 10,
  "maxPages": 5,
  "maxWallClockMs": 600000,
  "allowedDomains": [],
  "deniedDomains": [],
  "allowPrivate": false,
  "allowLogin": false,
  "sourceTier": "free-first"
}
~~~

- 只允许 http/https；
- 默认阻断 localhost、127/8、10/8、192.168/16、172.16-31/12、169.254/16、.local、IPv6 本地地址；
- allowedDomains 非空时只允许这些域名及其子域；
- 文件只允许 vault 相对路径，禁止 ..、绝对路径；
- 文件类型：csv/tsv/xlsx/xls/json/jsonl/md/txt/pdf。

## 6. Attempt 与预算

一次 attempt = 一组来源 + 一种策略 + 一个契约版本：

~~~text
attemptKey = sha256(sourceSet + strategy + feedback + contractHash)
~~~

- 同一 key 不允许重复跑，除非用户显式“强制重试”；
- 默认最多 3 次，耗尽 → needs_human；
- 用户可显式“强制重试”，最多额外 3 次（硬上限 = maxAttempts + 3）；
- 每次重试必须新增来源、换策略或给 feedback；
- 运行有 wall-clock 预算，worker 超时会被标记失败；
- 每次 attempt 记录来源、pid、日志、快照、记录数、错误。

## 7. Coverage 与 Gate

逐项计算，不用一个总百分比决定是否完成：

- 字段：value/unit/period/sourceUrl 是否齐；
- 单位：与契约单位是否一致（支持 元/CNY、港元/HKD 等别名）；
- 期间：按频率归一化后去重计数；
- 覆盖：got / expected 与最低覆盖率比较；
- 新鲜度：最新 dataAsOf 是否在允许滞后内；
- 来源：是否有 sourceUrl/locator/snapshot；
- 冲突：同一 item 多个已接受候选值不一致 → conflict；
- 质量门禁：日/月/季序列额外调用 data-quality.check，检查重复 period、period 格式、连续性、新鲜度；结构失败 → fail。

输出：

~~~json
{
  "overall": 0.82,
  "gate": "fail",
  "ready": false,
  "items": [
    { "index": 0, "gate": "warn", "coverage": 0.99, "got": 1485, "expected": 1500,
      "issues": ["数据可能过期：最新 2026-11-14"] }
  ],
  "missing": [{ "itemIndex": 1, "issue": "覆盖不足：2/5" }]
}
~~~

- gate=pass：全部硬门禁通过；
- gate=warn：可进入确认，但 UI 标黄；
- gate=fail：不能确认；
- ready = 没有 fail；
- overall >= 0.9 只用于 reviewSuggested。

## 8. 结构化 IO

### 创建

POST /api/datatask

~~~json
{
  "case": "c_a84f47daa19e",
  "needId": "N325",
  "itemIndexes": [0, 1, 2, 3],
  "sources": [
    { "kind": "url", "ref": "https://...", "role": "primary", "expectedItems": [0, 2] },
    { "kind": "file", "ref": "uploads/cmb.csv", "role": "attachment", "expectedItems": [1] }
  ],
  "policy": { "maxAttempts": 3, "maxPages": 5, "maxSteps": 10 }
}
~~~

### 候选

~~~json
{
  "taskId": "DT1",
  "attemptId": "DA1",
  "itemIndex": 0,
  "indicator": "招商银行H股前复权收盘价",
  "value": "32.15",
  "unit": "HKD",
  "period": "2026-11-14",
  "sourceUrl": "https://...",
  "locator": { "page": 2, "tableRow": 18 },
  "snapshotPath": "runtime/datatask/...",
  "sha256": "...",
  "confidence": 0.92,
  "dataAsOf": "2026-11-14",
  "status": "pending"
}
~~~

### Worker 回传

POST /api/datatask/attempt/finish

~~~json
{
  "case": "...",
  "id": "DT1",
  "attemptId": "DA1",
  "ok": true,
  "records": [ ... ],
  "notes": "...",
  "error": "",
  "stats": { "sources": 2, "records": 120 }
}
~~~

## 9. API

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | /api/datatask?case= | 列出任务 |
| GET | /api/datatask/get?case=&id= | 单个任务 + 候选 + 覆盖 |
| POST | /api/datatask | 创建任务 |
| POST | /api/datatask/source/add | 加来源 |
| POST | /api/datatask/start | 启动 attempt（dryRun:true 只建 attempt） |
| POST | /api/datatask/attempt/finish | worker 回传 |
| POST | /api/datatask/confirm | 确认写入 |
| POST | /api/datatask/waive | 豁免某项 |
| POST | /api/datatask/cancel | 取消 |

所有变更写 datatask.updated 账本事件；重启后回放重建。

## 10. UI

### 入口

缺口弹窗主按钮：**用模型补齐**。

- 选择要补的项；
- 填 URL（每行一个）；
- 上传文件；
- 设置 maxAttempts / maxPages / maxSteps；
- “创建并开始”或“只创建”。

### 任务卡

- 状态、总体覆盖、门禁；
- 逐项 checklist：指标、频率、区间、单位、gate、issues、豁免；
- 来源列表；
- attempt 记录；
- 候选表：值/单位/期间/来源/置信度/接受/拒绝；
- 按钮：添加来源、上传文件、开始/重试、强制重试、取消、确认写入。

### 队列

右栏「数据与证据 → 数据补齐任务」；问题导航显示“数据补齐 N”。

运行中的 DataTask 不再作为“待补数据”要求用户操作。队列状态：

- parsing → auto / datatask_running
- needs_more → human / datatask_needs_source（请补充来源或文件）
- ready / source_pending → human / datatask_ready
- ready_for_review → human / datatask_review
- needs_human / failed / write_failed → human / datatask_needs_human

重启对账：broker 重启后，parsing attempt 如果 worker 已不在，自动转 needs_more/needs_human；超过预算的 attempt 由 watchdog 标记失败。

## 11. 写入事务

用户点“确认写入”后：

1. 校验 ready_for_review；
2. 每个 item 选一个候选（默认最高 confidence）；
3. 同一 item 其他 pending 候选标记 rejected；
4. 写 evidence（带 taskId/attemptId/writeBatchId/sourceUrl/locator/confidence/dataAsOf）；多记录 item 写一条 series evidence，含 records 数组，item.value 记为 "start..end (N records)"；
5. need item 标记 provided；
6. 全部完成 → need 关闭；
7. 报告 stale；
8. 写 datatask.confirmed / datatask.closed。

失败时任务转 write_failed，返回 409/500 + recoverable:true；已写证据保留，再次 confirm 会跳过已 provided 项、继续写剩余项。

子集任务：DataTask 只覆盖部分 itemIndexes 时，只要本任务负责的项全部 provided/waived，任务即可 closed；need 仍 pending，等待其他任务补剩余项。

## 12. 安全与审计

- 网页内容是不可信数据，模型不执行页面指令；
- 默认阻断内网/本机 URL；
- 不登录、不绕付费墙；
- 文件只读 vault；
- 每条候选保留 sourceUrl、locator、snapshot、sha256、retrievedAt、extractor；
- 账本可重放；worker 日志在 runtime/datatask/。

## 13. N325 验收

N325 的 4 项：

1. H 股前复权收盘价：日频，覆盖率 ≥98%，单位 HKD，数据截至 ≤7 天；
2. 每股分红/除净日：2021–2025 逐年，字段齐；
3. HKD/CNY 官方中间价：日频，覆盖率 ≥98%；
4. 港股通红利税规则：文本，人工确认。

通过标准：

- 4 项全部 pass 或显式 waived；
- 用户确认后写 4 条（或合并）证据；
- N325 从待补队列消失；
- 报告标记 stale；
- 账本可重放。

### 真实 pilot 结果（2026-11-18）

- 第 3 项 HKD/CNY：中国货币网页面由 web.agent 只返回最新 1 条，覆盖 1/1423，needs_more；说明网页单页不能替代长序列。
- 用中国货币网 API 按年分页拉取 2021-2026，生成 CSV 1423 条；DataTask 文件来源解析后 gate=pass，确认写入 S80（系列证据，1423 records）；第 3 项 provided。
- 第 2 项分红：用 AkShare 港股分红派息数据生成 2021-2025 除净日/每股港币分红 CSV（5 条）；DataTask gate=pass，写入 S79（系列证据，5 records）；第 2 项 provided。
- 第 1 项 H 股前复权：Tushare hk_daily_adj 无权限；yfinance 限流；改用 AkShare 未复权日线 + 分红因子推导前复权 CSV（1444 条，方法为派生），DataTask gate=pass，写入 S78（系列证据，1444 records）；第 1 项 provided。
- 第 4 项税务规则：尚未取得可引用的官方规则链接，保持 pending，建议人工确认或提供官方页面。

> 说明：S75/S76/S77 是 pilot 早期“单点候选”记录，已被 S80/S79/S78 的系列证据替代；生产环境应避免单点接受长序列，当前代码已改为按 item 聚合 series evidence。

结论：长日频序列应优先走 CSV/API/connector；web.agent 适合结构化页面/附件/短序列，不适合一次抓完整历史。派生数据（如自算前复权）必须在报告中注明方法，不能当原始官方复权价。

## 14. 测试

~~~bash
node scripts/test-datatask.js          # 契约/覆盖/门禁/策略/attemptKey（25 项）
node scripts/test-datatask-flow.js     # 创建→start(dryRun)→finish→gate→confirm/waive（临时 broker）
node scripts/test-datatask-worker.js   # 文件→worker→CSV→候选→gate→confirm（临时 broker）
~~~

## 15. 当前边界 / 后续

已实现：

- URL 走 web.agent；文件走 CSV/XLSX 表格解析；
- 逐项 coverage/gate；
- 有界重试、来源策略、预算；
- 候选确认、事务写入、账本回放；
- 面板入口、任务卡、候选表。

暂未实现（P2）：

- PDF 表格/OCR 自动结构化（当前 PDF 只提取文本，需人工确认）；
- 多来源自动交叉校验（当前同 item 多候选会冲突，人工裁决）；
- 跨任务证据复用/去重（N325 的 S28/S29 仍由 preflight 提示）；
- 登录/验证码/付费墙；
- 无限滚动列表（paginate 支持下一页/页码，不支持无限滚动）。
