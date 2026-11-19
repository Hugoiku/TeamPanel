# 指标匹配与解析（Metric Resolution）· 闭环设计

> 状态：确定性层 + 封闭候选语义解析 + 别名预审核 + draft 审核流已实现（显式 ID / 精确别名 / 受控前缀 / 兼容门禁 / draft metric 创建/补来源/启用 / 语义匹配 / 超时回收 / match 状态 / 来源能力门禁 / proposed→pre_reviewed→active）。
> 目标：在不依赖无约束模糊匹配的前提下，让新 case 的不同表述也能稳定匹配到正确 metric，并且匹配过程可审计、可确认、可回放。

## 1. 设计目标

1. 支持新 case 的自然语言表述，不要求文本与 registry 完全一致。
2. 匹配结果必须可解释：命中了哪个 metric、依据是什么、置信度多少。
3. 定义/单位/频率不兼容时，禁止自动绑定。
4. 低置信度、歧义、无候选时进入明确的人工/草稿状态，不硬猜。
5. 人工确认过的映射可复用，但不能污染正式 registry。
6. 匹配状态和结果进账本，broker 重启后可回放。

## 2. 非目标

- 不做无候选集的文本相似度打分。
- 不因为“字面像”就自动绑定。
- 不自动把人工确认的别名升级为正式别名。
- 不要求一次匹配就永远正确；允许人工改选和撤回。

## 3. 匹配分层

1. 显式 metricId
2. 精确别名（normalize 后精确 key）
3. 封闭候选集语义解析
4. 确定性兼容门禁
5. 高置信自动绑定 / 中低置信人工确认 / 无候选建 draft

### 3.1 显式 metricId

员工上报 need 时如果知道指标，直接带 metricId、unit、frequency，不调模型。

### 3.2 精确别名

registry 维护 id、name、aliases。匹配时先 normalize（去空格、全半角、大小写、标点），然后精确比较 alias/name；不做包含、相似度、token 打分。

### 3.3 封闭候选集语义解析

文本没有精确命中时，调用模型做分类。输入是用户文本、单位、频率、时间范围，以及最多 20 个候选 metric 的 id/name/definition/unit/frequency/stockFlow/aliases。

模型输出必须是候选集里的 ID 或 unknown，并给出 confidence、reason、alternatives。不允许自由生成新 ID。批量解析，一次请求处理多个 item；结果缓存，同文本第二次不调模型。

### 3.4 确定性兼容门禁

即使模型置信度高，也必须通过：

- 单位：必须兼容；% 与 bp、亿元与万亿元需要显式换算，不自动假设。
- 频率：日/月/季/年必须兼容；日度需求不能自动绑年度指标。
- 存量/增量：存量、增量、同比、环比不能混。
- 地区/口径：中国/全球、官方/协会、采购额/台数等必须一致。
- 时间范围：候选覆盖范围必须覆盖需求范围，或明确标“部分覆盖”。
- 定义冲突：任一硬冲突，不得自动绑定。

硬冲突时，无论 confidence 多高，都进入 candidate_pending。

### 3.5 置信度策略

| 条件 | 动作 |
|---|---|
| confidence >= 0.90 且门禁全过 | 自动绑定 confirmed |
| 0.60 <= confidence < 0.90，或存在 alternatives | candidate_pending，人工选 |
| confidence < 0.60 | 不绑定，转 draft 或人工 |
| 无候选 | draft，不建自动采集任务 |
| 模型超时/失败 | unresolved，可重试；不阻塞人工补数 |

## 4. 状态机

### 4.1 Need item 匹配状态

    unresolved
      -> confirmed（显式 ID / 精确别名 / 高置信语义）
      -> candidate_pending（中低置信 / 歧义 / 定义冲突）
      -> draft（无候选）

    candidate_pending
      -> confirmed（人工选定）
      -> rejected（人工拒绝）
      -> draft（人工选择新建）

    rejected
      -> unresolved（重新匹配）
      -> draft

    draft
      -> proposed（补充定义/来源）
      -> active（审核通过，进入 registry）

### 4.2 自动采集联动

    confirmed -> 才允许 autoEnqueueNeed
    candidate_pending / draft / unresolved -> 不建自动采集 job，进入人工处理

### 4.3 别名状态

    proposed -> pre_reviewed -> reviewed -> active
    proposed -> rejected
    pre_reviewed -> rejected

规则：

- 人工确认匹配时，可勾选“把本次文本记为别名”；
- 只写入 proposed，不直接 active；
- 先经过自动预审核，再进入人工审核；
- 人工审核通过后才 active；
- 每次变更记录版本、操作者、依据。

### 4.4 别名预审核（自动层）

预审核只做确定性检查和模型辅助判断，不直接激活别名：

| 检查 | 处理 |
|---|---|
| 与已有 alias 完全重复 | 合并到已有别名，不新增 |
| 与另一个 metric 的 alias 冲突 | 标记冲突，进入人工裁决 |
| 文本过于宽泛（数据、指标、金额等） | 拒绝 |
| 单位/频率/存量增量与目标 metric 不兼容 | 拒绝 |
| 模型判断语义不一致 | 标记风险，进入人工 |
| 文本含 case 特定限定词 | 标记“仅本 case”，不进入全局 registry |
| 预审核通过 | 状态 pre_reviewed，等待人工审核 |

预审核结果必须记录：通过/拒绝、原因、检查项、时间。  
只有 `active` 别名参与生产匹配；`proposed / pre_reviewed` 只作为待审列表，不参与自动绑定。

## 5. 数据模型

### 5.1 Metric Registry

字段：id、name、definition、unit、frequency、stockFlow、region、aliases、status、version、reviewedBy、reviewedAt。

### 5.2 Need item resolution

字段：indicator、metricId、match.state、match.method、match.confidence、match.candidates、match.reason、match.confirmedBy、match.confirmedAt。

## 6. 账本事件

| 事件 | 载荷 |
|---|---|
| metric.resolve.started | needId, itemIndex, text |
| metric.candidate | needId, itemIndex, metricId, confidence, reason, alternatives |
| metric.resolved | needId, itemIndex, metricId, method, confidence |
| metric.confirmed | needId, itemIndex, metricId, by, method |
| metric.rejected | needId, itemIndex, metricId, reason, by |
| metric.draft.created | needId, itemIndex, draftMetricId |
| metric.alias.proposed | metricId, text, by |
| metric.alias.prechecked | metricId, text, pass, checks, reasons |
| metric.alias.reviewed | metricId, text, decision, by, reason |
| metric.alias.approved | metricId, text, by |

回放要求：

- match.state / metricId / candidates 重启后不丢；
- 未完成的语义解析不能永久 running；
- 人工确认结果优先于自动匹配。

## 7. UI 设计

### 7.1 缺口卡片

显示匹配状态（已确认/待确认/草稿/未匹配）、metric ID 与名称、匹配依据、操作（确认/改选/新建 draft）。

### 7.2 待确认弹层

展示 2–3 个候选：ID、名称、定义、单位、频率、差异点。操作：选择正确候选、拒绝并重新匹配、新建 draft。可勾选“把本次文本记为别名”，进入 proposed。

别名提案进入独立待审列表，显示预审核结果（通过/拒绝/冲突/过于宽泛/仅本 case），人工审核通过后才 active。

### 7.3 约束

- 高置信自动绑定也要显示依据，允许改；
- 低置信不自动建采集任务；
- 失败显示原因和重试，不吞错误。

## 8. 失败路径

| 情况 | 处理 |
|---|---|
| 模型超时 | unresolved，可重试；不阻塞人工 |
| 模型返回非法 ID | 视为无结果，转人工 |
| 多候选同分 | candidate_pending，人工选 |
| 定义冲突 | candidate_pending，人工确认或建 draft |
| 无候选 | draft，不自动采集 |
| 人工拒绝 | rejected，可重新匹配或 draft |

## 9. 验收用例

1. 文本“社融”精确别名 -> macro.tsf
2. 文本“社会融资规模”精确别名 -> macro.tsf
3. 文本“社融存量同比”语义匹配到 macro.tsf 但存量/增量冲突 -> candidate_pending
4. 文本“DR007”精确别名 -> macro.dr007
5. 文本“银行间7天回购”语义匹配 -> macro.dr007
6. 文本“专项债进度”无候选 -> draft，不建自动 job
7. 多候选歧义 -> 人工选择后 confirmed
8. 人工确认时勾选别名 -> 写 proposed，不直接 active
9. 别名与已有 alias 重复 -> 预审核合并，不新增
10. 别名与另一个 metric 冲突 -> 预审核标记，人工裁决
11. 别名单位/频率不兼容 -> 预审核拒绝
12. 预审核通过 -> pre_reviewed，人工审核后才 active
13. 重启后 match.state / metricId / alias 状态不丢
14. 同一文本第二次匹配直接命中缓存，不调模型

## 10. 迁移与灰度

1. 保留现有模糊匹配，但只作为 fallback，不直接绑定；
2. 新 resolver 先 shadow 运行，对比结果，不改变自动采集；
3. 通过验收后再替换 autoEnqueueNeed 的匹配逻辑；
4. 现有 need 不回填 metricId，只在新 need / 重新匹配时使用；
5. N193 这类历史缺口可手动“重新匹配”，不强制迁移。

## 11. 特性符合性

| 要求 | 本设计 |
|---|---|
| 智能 | 封闭候选语义解析，处理不同表述 |
| 可靠 | 定义/单位/频率确定性门禁 + 人工确认 |
| 专业 | 以 metric 定义和口径为准，不以字面相似为准 |
| 闭环 | 状态机 + 账本事件 + 失败路径 + 回放 |
| 不膨胀 | 只用于 data need；批量 + 缓存；不新增全局面板 |
| 可审计 | method/confidence/candidates/confirmedBy 全留痕 |

## 12. 已确认决策

1. 高置信自动绑定阈值：0.90。
2. 别名：增加自动预审核层，pre_reviewed 后仍需人工审核；只有 active 参与生产匹配。
3. 定义冲突：允许“强制绑定”，但必须记录理由、操作者、时间，并标记风险。
4. 历史 need：提供“一键重新匹配”，不强制迁移。
