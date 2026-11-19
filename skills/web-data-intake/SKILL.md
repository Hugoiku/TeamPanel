---
name: web-data-intake
description: 通过对话解析用户提供的网页，判断是否满足待补数据要求；不足则记录尝试并继续要 URL，不擅自标记完成
version: 1.0.0
category: data
---

# 网页数据补充（对话式）

## 何时用
用户发来 URL，要求补充某个待补数据项，或要求从网页提取数据。

## 原则
- 不同网页格式不同，不预设固定字段/选择器；先看页面实际内容。
- 网页可见不等于数据充分；必须对照待补项的 frequency / range / unit / format 判断。
- 数据不足时：只记录解析尝试，**不要**把待补项标记为 provided。
- 不绕过登录、付费墙、验证码；不批量抓取。

## 流程
1. 读取目标待补项：GET /api/needs?case=<case>，找到 need.id 与 spec.items[index]。

1.5 自动匹配候选待补项：GET /api/need/match?case=<case>&text=<页面标题/用户描述>。
    - confidence=high：预选该 need/index，但仍要在回复中写明“将补到 Nxx 第 i 项”；
    - confidence=medium：列出 2–3 个候选，让用户选；
    - confidence=low 或多项同分：不要自动绑定，先问用户。
2. 浏览器抓取页面：
   node scripts/collect.js get "<URL>" --browser --out runtime/cache/collect/web-intake.md
3. 检查页面文本、表格、图表数据；归一化日期、品种、单位、口径。
4. 对照要求计算覆盖：时间范围、频率、点数、单位、字段。
5. 不满足：
   - POST /api/need/item/attempt
     { case, id, index, url, found, coverage, requirement, missing, note, by }
   - 回复用户：找到了什么、缺什么、为什么仍不完整；建议继续提供历史价格页/API/数据商 URL。
   - 待补项保持 pending。
6. 满足：
   - 先给用户预览字段/数值/区间；
   - 用户确认后，再按现有入库流程写证据并提供 item；
   - 不要未经确认直接关闭缺口。

## 示例判断
Mysteel 单日行情页只给一个交易日的锗锭/二氧化锗价格；
若要求“月度 2025-01 至 2026-10”，则覆盖不足，只能记录尝试，不能标完成。
