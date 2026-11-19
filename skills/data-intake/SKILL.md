---
name: data-intake
description: 动态数据获取：按 need/指标查数据源，优先复用 connector recipe；未知来源生成草案并验证，缺口报 need
version: 1.0.0
category: data
---

# 动态数据获取（data-intake）

目标：不要写死“某个指标必须去某个固定页面”。先找源，再决定抓法；能复用 recipe 就复用，不能则生成草案。

## 1. 输入

- metric / indicator
- 频率、时间范围、单位、口径
- need id / index（如果有）

## 2. 先查已有能力

```bash
node scripts/connector.js --list
curl -s "http://127.0.0.1:7801/api/data/plan?metric=media.box_office&range=2026-01..2026-10"
curl -s "http://127.0.0.1:7801/api/data/jobs?case=<case>"
```

## 3. 选择抓取方式

- JSON API：优先
- HTML 表格：其次
- PDF/XLSX：再次
- 浏览器渲染：最后
- 登录/付费/验证码：不做，报 need

## 4. 没有 recipe 时

```bash
node scripts/connector.js --draft --id <id> --source <source> --url <url> --type html-table --period-col 月份 --value-col 同比 --unit "%"
node scripts/connector.js --validate --id <id>
```

validate 返回 records 后才能：

```bash
node scripts/connector.js --approve --id <id>
```

## 5. 有 recipe / 队列时

```bash
curl -s -X POST http://127.0.0.1:7801/api/data/jobs -H "content-type: application/json" -d @data-job.json
```

## 6. 结构化与覆盖

必须得到：

```json
[{ "period": "2026-01", "value": 63.2, "unit": "亿元" }]
```

再算 coverage。没有 records 或 coverage 不足，不得写“已完成”。

## 7. 写证据

每条关键数字写：

- url
- fetched_at
- raw / snapshot
- field / value / unit
- coverage
- [S#]

## 8. 失败处理

- 重试：最多 3 次
- 换源：fallback
- 换 recipe
- 仍失败：报 need（缺什么、建议去哪拿）

不要：

- 编数字
- 把页面标题当数据
- 抓无授权页面
- 跳过 coverage/evidence
