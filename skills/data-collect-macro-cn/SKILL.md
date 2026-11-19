---
name: data-collect-macro-cn
description: 宏观/行业数据采集包：东财宏观、Tushare、统计局、财政部、中债、DXY、波动率、USGS
version: 1.0.0
category: data
---

# 宏观数据采集包

## 何时用
需要中国宏观（CPI/PPI/PMI/GDP/固投/进出口/M2/社融）、资金价格、DXY、指数波动率、房地产、财政、USGS 锗数据时。

## 命令
~~~bash
node scripts/collect.js source list
node scripts/collect.js source eastmoney-cpi --evidence
node scripts/collect.js source tushare-api --var api=cn_cpi --var 'params={"start_date":"20260101"}'
node scripts/collect.js source stats-release --var keyword=房地产
node scripts/collect.js source stats-release --var keyword=工业增加值
node scripts/collect.js source mof-release --var keyword=财政收支
node scripts/collect.js source chinabond-10y --evidence
node scripts/collect.js source csi300-vol --var code=000300
node scripts/collect.js source usgs-germanium --evidence
~~~

## 规则
- 每个被引用数字必须带 [S#]；优先 --evidence 自动入库；
- 先查 source list，再决定是否 desk need；
- 抓取失败时区分：robots/付费墙/字段缺失/需要 PDF 解析；
- 本包不含央行/金监总局 PDF 解析，相关数据需上传或另装。
