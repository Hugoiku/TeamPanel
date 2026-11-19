# 来源包 v2 · 闭环设计

> 状态：v2 核心已实现（source / parseJob / candidate / conflict / close / 回放），UI 初版已接；非结构化材料的模型抽取仍未实现。
> 目标：把“多来源、多文件、非结构化材料、来源冲突”做成可回放、可验收的闭环，而不是再加一个输入框。

## 1. 设计目标

1. 一个缺口可以挂多个来源（URL / 文件），一个来源可以抽出多个指标。
2. 解析结果先进入候选表，**不自动入库**；人工接受/拒绝后才生成证据。
3. 同一指标多来源不一致时并列展示，不静默覆盖；冲突必须显式裁决或豁免。
4. 只有所有指标都有“已接受证据”或“显式豁免”，缺口才允许关闭。
5. 缺口关闭后：解除计划阻塞 → 已有报告标记 stale → 重建后清除。
6. 所有状态变化进账本，broker 重启后可回放。

## 1.1 与指标匹配的关系

来源包解决“数据从哪里来、候选怎么确认”；指标匹配解决“这段文本对应哪个 metric”。匹配规则、状态机和别名治理见 [METRIC-RESOLUTION.md](./METRIC-RESOLUTION.md)。未 confirmed 的指标不进入自动采集，也不应直接生成候选。

## 2. 非目标

- 不做“自动相信解析结果”：候选必须人工确认。
- 不把单一 URL + 单字段 + 单数值当成唯一模型。
- 不在此版本做来源定时刷新、代理池、权限分级。
- 不为了“多来源”而允许无来源、无位置、无口径的数值入库。

## 3. 数据模型

### 3.1 Source

```json
{
  "id": "SRC1",
  "needId": "N175",
  "kind": "url | file",
  "ref": "https://example.com/a.pdf",
  "label": "公司年报 2025",
  "addedBy": "you",
  "addedAt": "2026-11-16T...",
  "status": "added | parsing | parsed | failed",
  "lastError": "",
  "parseJobId": ""
}
```

约束：

- 同一 need 下 `kind + ref` 去重，重复添加返回已有 source。
- 文件 ref 使用 `vault/uploads/...` 相对路径；URL 必须是 http(s)。

### 3.2 ParseJob

```json
{
  "id": "PJ1",
  "needId": "N175",
  "sourceId": "SRC1",
  "status": "queued | running | done | failed",
  "extractor": "url_preview | extract_table | model | manual",
  "startedAt": "",
  "finishedAt": "",
  "error": "",
  "candidateCount": 0
}
```

一个 source 可多次解析（失败重试），保留历史 job，不覆盖。

### 3.3 Candidate

```json
{
  "id": "C1",
  "needId": "N175",
  "itemIndex": 0,
  "sourceId": "SRC1",
  "parseJobId": "PJ1",
  "indicator": "分环节国产化率-整机",
  "value": "42.5",
  "unit": "%",
  "period": "2025",
  "locator": { "page": 12, "table": 2, "row": 3, "cell": "B3", "text": "整机国产化率 42.5%" },
  "confidence": 0.78,
  "extractor": "url_preview",
  "status": "pending | accepted | rejected | superseded",
  "decidedBy": "",
  "decidedAt": "",
  "rejectReason": "",
  "conflictGroup": ""
}
```

约束：

- `value` 只存文本；数值/单位/期间分开存，便于冲突比较。
- 没有 `sourceId`、`locator`、`period`、`unit` 的候选不得被接受。
- 拒绝也保留，不能静默删除。

### 3.4 Evidence

沿用 `evidence/sources.jsonl`，新增字段：

```json
{
  "id": "S123",
  "candidateId": "C1",
  "sourceId": "SRC1",
  "url": "https://example.com/a.pdf",
  "field": "分环节国产化率-整机",
  "value": "42.5",
  "unit": "%",
  "period": "2025",
  "locator": { "page": 12, "table": 2, "row": 3 },
  "confidence": 0.78,
  "source_tier": "official",
  "sha256": "..."
}
```

只有 `status=accepted` 的候选可以生成 evidence；一个候选只能生成一条 evidence。

### 3.5 Conflict

```json
{
  "id": "CF1",
  "needId": "N175",
  "itemIndex": 0,
  "candidateIds": ["C1", "C2"],
  "state": "open | resolved | waived",
  "resolution": {
    "chosenCandidateId": "C1",
    "reason": "年报口径，优先于协会口径",
    "by": "you",
    "at": "2026-11-16T..."
  }
}
```

冲突判定：

- 同一 item 有 ≥2 个候选被接受；
- 且 `value/unit/period` 不完全一致；
- 则自动创建 `conflict`，状态 `open`。

## 4. 状态机

### 4.1 Source

```text
added → parsing → parsed
              ↘ failed → retry → parsing
```

### 4.2 Candidate

```text
pending → accepted → evidence
       ↘ rejected
accepted → superseded（同 item 有新的冲突裁决时）
```

### 4.3 Need 关闭条件

```text
human_required
  → 所有 item 至少一个 accepted candidate，且无 open conflict
  → human_provided
  → closed
```

例外：

- 允许显式 `waive` 某个 item 或 conflict，但必须写理由、操作者、时间；
- 未解决冲突时，“关闭缺口”按钮禁用，只能“去裁决”或“显式豁免”。

### 4.4 下游

```text
closed → plan.unblocked
       → report.stale（如果已有 final-report）
       → 重新生成报告 → manifest 更新 → stale 清除
```

## 5. API 设计

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/need/source/add` | 添加 URL/文件来源，去重 |
| GET | `/api/need/source/list?case&id` | 来源、解析状态、错误 |
| POST | `/api/need/source/parse` | 解析指定来源（或全部），创建 ParseJob |
| GET | `/api/need/candidates?case&id` | 候选、冲突、已接受证据 |
| POST | `/api/need/candidate/decide` | 接受/拒绝候选 |
| POST | `/api/need/conflict/resolve` | 选择主候选或豁免冲突 |
| POST | `/api/need/item/waive` | 显式豁免某指标 |
| POST | `/api/need/close` | 校验关闭条件后关闭缺口 |

兼容：

- 现有 `/api/need/item/provide` 保留为“手工录入”，但必须生成 candidate + evidence，不能绕过候选表。
- 现有 `/api/need/preview-url` / `commit-url` 逐步废弃，只保留内部解析用。
- `GET /api/needs` 继续返回 `queue/stage/reason`，新增 `candidateSummary`。

## 6. 账本事件

| 事件 | 载荷 |
|---|---|
| `need.source.added` | needId, sourceId, kind, ref |
| `need.parse.started` | needId, sourceId, parseJobId |
| `need.parse.finished` | needId, sourceId, parseJobId, ok, candidateCount, error |
| `need.candidate.created` | needId, candidateId, itemIndex, sourceId, value, unit, period, locator |
| `need.candidate.decided` | needId, candidateId, decision, reason |
| `need.conflict.opened` | needId, conflictId, itemIndex, candidateIds |
| `need.conflict.resolved` | needId, conflictId, chosenCandidateId / waived, reason |
| `need.closed` | needId, evidenceIds |
| `report.stale` | 沿用现有 |

回放要求：

- source / parseJob / candidate / conflict 都能从账本重建；
- 重启后未完成的 parseJob 标 `failed` 或重新排队，不能永久 running。

## 7. UI 设计

缺口弹窗改为三段：

### 7.1 来源包

- 来源列表：类型、名称、状态、最后解析时间、错误、重试按钮；
- 添加：多 URL（每行一个）+ 多文件上传；
- 不在这里直接填字段/数值。

### 7.2 候选表

按指标分组，每行：

- 指标、候选值、单位、期间、来源、位置（页码/表格/行）、置信度；
- 操作：接受 / 拒绝 / 查看原文；
- 状态：待确认 / 已接受 / 已拒绝 / 被替代。

### 7.3 冲突与关闭

- 冲突区：同一指标多来源不一致，并列展示；
- 操作：选主来源 / 豁免冲突（填理由）；
- 关闭按钮：
  - 全部 item 有 accepted evidence 且无 open conflict → 可用；
  - 否则显示“还差 N 项 / 冲突 N 个”，禁用。

### 7.4 交互约束

- 解析中禁用重复解析；
- 接受/拒绝幂等；
- 失败显示原因和重试，不吞错误；
- 关闭后弹窗显示“已关闭 → 计划已解阻塞 / 报告待重建”。

## 8. 报告集成

- 报告只引用 `accepted` 候选生成的 evidence；
- 冲突已裁决：引用 chosenCandidateId 的 evidence；
- 冲突被豁免：报告标注“该指标存在来源分歧，采用 X 口径”，并引用 chosen 或明确不引用；
- 未关闭缺口不得进入正式报告流水线。

## 9. 迁移

1. 现有 `item.status=provided` 的数据保留，不回填候选；
2. 现有 v1 来源包 URL 不持久化，v2 上线后重新添加；
3. 旧 `needUrl` 单 URL 入口已删除，不再恢复；
4. `/api/need/commit-url` 标记 deprecated，仅内部使用。

## 10. 验收用例

1. 添加 2 个 URL + 1 个文件，解析成功，候选生成；
2. 接受 1 个候选，evidence 写入且带 locator；
3. 两个来源同指标不同值，冲突打开，关闭按钮禁用；
4. 裁决冲突后，选中的候选生成 evidence，缺口可关闭；
5. 拒绝候选不生成 evidence，item 仍缺；
6. 解析失败显示原因，可重试；
7. broker 重启后 source/candidate/conflict 不丢；
8. 缺口关闭 → plan 解阻塞 → 报告 stale；
9. 重新生成报告 → stale 清除 → 可签发；
10. 重复添加同一来源、重复解析、重复接受均幂等。

## 11. 风险与取舍

- 解析质量：v2 仍先用 `url_preview` / `extract_table`，非结构化 PDF 再接模型；候选必须人工确认。
- 冲突过多：允许显式豁免，但必须留理由，不能默认选一个。
- 数据量：候选/解析历史按 need 归档，不无限增长。
- 兼容：v1 已提供数据不回填候选，避免伪造来源位置。

## 12. 实施顺序

1. 数据模型 + 账本事件 + 回放；
2. source add / parse / candidate API；
3. candidate decide / conflict resolve；
4. 关闭条件与 plan 解阻塞、report stale；
5. UI 来源包 / 候选表 / 冲突区；
6. 验收用例与重启回放测试；
7. 最后移除 v1 `commit-url` 主路径。
