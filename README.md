# 天枢 · 边界智能投研 Agent

> HugoTeam 天枢 · 投研工作流中枢  
> 让模型在边界内做更复杂的判断，让系统在边界外做更可靠的交付。

天枢不是“给聊天窗口加几个按钮”，而是把投研工作拆成一条可监督、可恢复、可复现的工作流：

~~~text
Case → Plan → WorkItem → Employee Loop → Gate → Evidence → Report → Sign → Verify
~~~

6 名 AI 员工 + 1 个 Lead 在同一份 case 上协作：宏观、行业、个股、审计、法务、交易。员工的文件读写走 Broker 的锁队列与版本 CAS，全过程写入 append-only 账本；三栏面板从账本投影出“谁在做什么、交付了什么、卡在哪”。

> 面向 A 股/中国宏观，默认中文界面。研究结论仅为流程演示，不构成投资建议。

## 为什么不是单 Agent 对话

| 关键需求 | 普通 DeepSeek Harness | 单 Agent 对话 | 天枢 |
|---|---|---|---|
| 任务组织与依赖 | △ | — | √ |
| 计划审批 | — | — | √ |
| 质量验收（投研） | — | — | √ |
| 数据与证据链 | △ | — | √ |
| 失败恢复 | △ | — | √ |
| 成本 / 配额控制 | △ | — | √ |
| 报告交付与复现 | △ | — | √ |
| 监督与人工接管 | — | — | √ |

> √ 原生支持；△ 部分支持/需要人工拼接；— 不具备。  
> 普通 DeepSeek Harness 强在通用执行，单 Agent 对话强在低门槛，天枢强在“任务有契约、数据有来源、失败可恢复、报告可签发”。

## 核心能力

- **计划与 WorkItem**：Lead 生成计划，人工批准后按 DAG 拆成 WorkItem；每个节点有依赖、产物、tier、预算与失败策略。
- **有界员工循环**：maxRounds / maxTokens / maxWallMs / maxSubagents / lease，模型可自主判断，但不能无限跑、无限加预算。
- **确定性 Gate**：不靠模型自称完成；检查文件、章节、引用、数据质量、新鲜度、交叉校验。
- **DataGateway**：统一取数入口，带来源策略、配额、幂等、契约校验、快照与 S# 证据。
- **DataTask / DataJob**：已注册指标走确定性 DataJob；未知/异构数据走 DataTask（URL/文件），人工确认后入库。
- **失败语义与恢复**：wall_timeout / heartbeat_timeout / artifact_missing / citation_missing / budget_exceeded，对应重试、拆分、修契约、升级人工。
- **可复现报告**：报告 manifest、signature、sha256、证据 snapshot、dataAsOf；签发后可 verify。
- **三栏监督台**：左栏“下一步”、中栏“现在发生什么”、右栏“出了事去哪看”。
- **单用户生产保障**：卡死告警、僵尸 loop 清理、备份/恢复、死信重放、配额与 license 治理。

## 架构

~~~text
浏览器：天枢三栏监督台
        │ HTTP
Broker + Ledger
  锁队列 / 版本 CAS / 门禁 / 复核 / 告警 / 账本
        │ WorkItem / run-dag
Employee Loop  →  Agent Runtime（dsh / OpenAI-compatible / fake）
        │ Tool Gateway
DataGateway  →  来源 / connector / collect / 文件解析
        │
vault/<case>/          研究产物、报告
evidence/sources.jsonl 证据 S# / snapshot / sha256
runtime/ledger/        append-only 事件账本
~~~

## 使用前提：从 GitHub 拉取后能用到什么程度

### 1. 只看 Panel（最小前提）

必须：

- **Node.js ≥ 18**（推荐 22 LTS）；
- 能 clone 仓库并写入运行目录；
- 现代浏览器。

**不需要**：DeepSeek Harness、模型 API Key、Python、数据库、Redis。

~~~bash
git clone <repo-url> TeamPanel
cd TeamPanel
node scripts/init-worktree.js --demo
./start.sh
~~~

可以打开面板、看 demo/历史账本、泳道图、交付物、模型/技能配置。  
**不能**启动员工、自动采集数据或自动生成报告。

### 2. 派活、跑员工（完整研究前提）

在最小前提上增加：

- **必须安装 DeepSeek Harness（dsh CLI）**，并确保 dsh 在 PATH；
- 或用 DSH_BIN 指定 dsh 路径；
- 配置模型凭据（OpenAI 兼容网关，或 dsh 支持的 provider）；
- 能访问模型 API 的网络。

没有 dsh 时面板仍能打开，但员工无法启动，顶部会显示「未找到 dsh · 员工无法启动」。  
没有模型凭据时，可以看板/整理数据，但不能真正跑研究。

~~~bash
cp .env.example .env
# 填自己的模型/数据源 key，不要提交

cp config/desk.json config/desk.local.json
# 本机端口/模型覆盖，已被 gitignore

./start.sh
~~~

首次没有预置模型：打开面板 → 左下角「模型配置」→「＋ 新建模型配置」，填一个 OpenAI 兼容网关，保存并应用。

### 3. 数据采集与报告

- **网络**：访问模型 API 与目标数据源；
- **可选数据源凭据**：Tushare 积分、FRED key、A2A 等；没有就使用免费源或上传 CSV；
- **可选 Python 3**：
  - 解析 xlsx/pdf：需要 openpyxl / pypdf；
  - 生成 docx 报告：需要 python-docx；
  - 不装 Python 也可用 CSV/已有文本，但部分报告/表格能力受限；
- **数据 license**：第三方数据的报告使用范围由使用者自行确认。

### 4. 部署与使用限制

- **单机、单用户**：没有多租户、RBAC、分布式配额；
- **不要直接把 Broker 暴露到公网**；
- 远程访问需要 --token + 可信网络；
- 无需数据库/Redis，但运行数据会写入 runtime/ 和 vault/，需要可写磁盘；
- 模型 token 与付费数据源费用由使用者承担；仓库不提供 API 额度；
- 研究流程演示，不构成投资建议；审计/法务结论不替代真实合规审查。

## 快速开始

~~~bash
git clone <repo-url> TeamPanel
cd TeamPanel

cp .env.example .env
cp config/desk.json config/desk.local.json

node scripts/init-worktree.js --demo
./start.sh
~~~

打开：

~~~text
http://127.0.0.1:7801/live
~~~

首次使用没有预置模型：打开面板 → 左下角「模型配置」→「＋ 新建模型配置」，填一个 OpenAI 兼容网关（Base URL / 协议 / env:YOUR_API_KEY），保存并应用，然后派活。

Windows 使用 start.cmd，不需要 WSL；DSH 通常是 dsh.cmd，也可以设置 DSH_BIN。

## 配置与安全

- 真实 key 只放在 .env 或 runtime/secrets/，不要写进源码或配置；
- config/desk.local.json 用于本机端口/模型覆盖，已被 gitignore；
- vault/、drafts/、runtime/ 默认不提交；
- 详细说明见 [SECURITY.md](SECURITY.md)。

~~~bash
# 提交前检查
git status --short
git ls-files | grep -Ei 'secret|credential|\.env$|\.pem|\.key$|desk\.local'
~~~

## 面板

- **左栏**：case 名称、下一步、待处理、数据缺口、计划、交付物。
- **中栏**：工作流泳道图、对话/日志、报告预览、计划详情。
- **右栏**：计划与 WorkItem、数据源、证据、复核、执行/运维、告警。

常见操作：

- 待批计划 → 批准并执行；
- 数据缺口 → 补 URL/文件，或走 DataTask；
- 失败节点 → 重试、修契约、拆分（人工确认）；
- 全部完成 → 报告装配 → 审计/法务 → 签发；
- 卡住 → 顶部告警条直接告诉你哪里停了。

## 目录

| 路径 | 作用 |
|---|---|
| runtime/server/broker.js | 零依赖 Broker：锁队列 / CAS / 账本 / 门禁 / 面板 API |
| dashboard/ | 天枢三栏面板（template.html → build.js → mockup.html） |
| runtime/agents/employee.js | 启动员工 dsh headless 会话 |
| scripts/desk | 员工唯一写入口 CLI（acquire / write / gate / need / review / kb） |
| scripts/run-dag.js | WorkItem DAG 调度器 |
| scripts/employee-loop.js | 有界 Employee Loop |
| scripts/data-gateway.js | 数据采集统一执行层 |
| agents/ | 角色卡与共享协议 |
| skills/ | 技能目录 |
| config/desk.json | 角色 / 模型 / 技能 / 端口配置 |
| docs/ | 设计、数据、WorkItem、Quickstart 文档 |
| vault/ | 用户 case 产物（gitignore） |
| runtime/ledger/events.jsonl | 事件账本（gitignore） |

## 开发与测试

~~~bash
npm test          # 面板 + Broker + 数据质量/来源链基础测试
npm run test:all  # 更完整的 WorkItem / DataTask / 数据请求回归
~~~

常用单项：

~~~bash
node dashboard/test.js                 # 面板 202 项
node runtime/server/test/run.js        # Broker 18 项
node scripts/test-work.js              # WorkItem 16 项
node scripts/test-data-request.js      # DataGateway / DataTask / 来源策略
node scripts/test-datatask.js          # DataTask 契约 / 覆盖 / 门禁
node scripts/verify-report.js --case <case>  # 报告可复现校验
~~~

## 文档

- [docs/QUICKSTART.md](docs/QUICKSTART.md) — 启动、模型、凭据、跨机器访问
- [docs/DESIGN.md](docs/DESIGN.md) — 整体设计
- [docs/AGENT-LOOP.md](docs/AGENT-LOOP.md) — 双层有界 Agent / WorkItem
- [docs/DATA-COLLECTION.md](docs/DATA-COLLECTION.md) — 数据采集、DataGateway、来源策略
- [docs/DATA-TASK.md](docs/DATA-TASK.md) — 缺口补齐 / DataTask
- [docs/WEB-DATA-INTAKE.md](docs/WEB-DATA-INTAKE.md) — URL/PDF/文件入库
- [docs/DATA-SOURCE-MATRIX.md](docs/DATA-SOURCE-MATRIX.md) — 数据源适用性

## 当前状态

~~~text
数据采集：单团队生产级
任务规划 / 员工执行：生产 beta
报告闭环 / 连续 case 验证：仍在推进
整体定位：单用户投研工作台，生产 beta
~~~

当前仓库是单机、单用户工作台，没有多租户与细粒度权限。不要把 Broker 直接暴露到公网；需要远程访问时请配置 --token 并放在可信网络内。

## License

[Apache-2.0](LICENSE)
