---
name: shared-report
description: 共享研究报告：各角色编辑 sections/<role>.md，总报告 master.md 由装配器生成；写操作走 desk 锁队列
version: 1.0.0
category: report
---

# 共享研究报告

## 文件
- reports/sections/macro.md
- reports/sections/industry.md
- reports/sections/stock.md
- reports/master.md（由装配器生成，默认不要直接编辑）

## 规则
- 每个角色只写自己的章节文件，用 desk acquire W -> read/peek -> write expected-version -> release。
- 总报告 master.md 只读汇总；需要跨章节修改时，才申请 master 写锁，并尽快 release。
- 写锁独占，读锁可共存；锁队列 FIFO，写优先；拿不到锁要看 position 并等待，不要换路径绕开。
- 写前必须 peek 最新版本；使用 expected-version，冲突就重新读、合并、再写。
- 长时间写作要 renew 租约。

## 装配
    DESK_CASE=<case> DESK_ACTOR=you node scripts/master_report.js --init
    DESK_CASE=<case> DESK_ACTOR=you node scripts/master_report.js

## 边界
- 锁只保证互斥和顺序，不自动合并内容。
- 整文件锁粒度较粗；优先按章节文件拆分，减少等待。
- 面板「文件锁 / 排队」显示当前持有与排队。
