---
name: macro-report
description: 从宏观底稿装配规范化 Word 研究报告（封面/目录/研究框架/图表/附表）
version: 1.0.0
category: report
---

# 宏观研究分析报告装配

## 何时用
宏观研究已完成、需要交付标准化 Word 研究报告时。技能会先扫描可得数据，再决定章节、图表和解读，不把固定文案套到所有课题上。

## 前置
- research/macro.md 已写入；
- evidence/sources.jsonl 可解析；
- 相关数据在 uploads/ 或已由 collect 入库；
- 图/表数据口径与底稿一致。

## 命令
    DESK_CASE=<case> DESK_ACTOR=you node scripts/macro_report.js

输出：
- reports/macro-report.md
- reports/macro-report.docx

也可从面板「签发报告」列表直接预览/下载/签发。

## 结构
- 封面
- 目录（独立页）
- 研究分析框架（课题框架图，不是工作流）
- 正文：现状、季节、需求、政策、市场验证、情景与风险
- 风险提示/免责声明
- 附表 A 指标与口径、A2 出口结构、B 研究口径、C 证据来源、D 待补事项

## 规则
- 先扫描 uploads/evidence/macro.json 生成数据清单；
- 根据可得指标选择章节与图表；缺失章节不强行保留；
- 正文只做解读，不逐项复述表格数字；
- 每张图必须有标题、资料来源，居中、图题紧贴；
- 表格不重复放来源列；
- 不编造数据；缺数据进附表 D；
- 签发前预览 Word，确认版式和内容。
