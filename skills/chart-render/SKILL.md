---
name: chart-render
description: 用 scripts/chart.js 把数据做成 SVG 图表（折线/柱状/横向条形）
version: 2.0.0
category: viz
---

# 图表渲染（chart-render）

报告必须可视化。任何有序列/对比的数据，都应该配一张图。

## 命令

```bash
node scripts/chart.js line --csv data.csv --x 日期 --y 数值 --title "CPI 同比" --source "[S1][S2]" --out figures/macro-cpi.svg
node scripts/chart.js bar  --csv data.csv --label 指标 --value 数值 --title "关键指标" --out figures/macro-bars.svg
node scripts/chart.js hbar --csv data.csv --label 公司 --value PE --title "可比 PE" --out figures/peers.svg
```

- 输入 CSV（或 JSON 数组），输出 SVG；零依赖；
- `--source` 写来源 `[S#]`，`--color` 可换色；
- 图表存 `figures/`，底稿用 `![图X 标题](figures/xxx.svg)` 引用；
- 每张图必须有：标题、单位/口径、来源 [S#]；没有数据不要画示意图冒充数据。

## 选图规则

- 时间序列 → 折线（line）；
- 分类对比/排名 → 横向条形（hbar）；
- 少量指标对比 → 柱状（bar）；
- 关系/结构图（非数据）可以另做示意图，但必须标注「示意图，非数据图」。

