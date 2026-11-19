# 天枢 · 边界智能投研 Agent

把「一个投研团队」做成可观测、可监督、可复现的 Agent 工作流：6 名 AI 员工在同一份研究项目上协作，文件读写走锁队列与版本 CAS，全过程记进 append-only 账本，面板从账本投影出「谁在做什么、交付了什么、卡在哪」。

> HugoTeam 天枢 · 投研工作流中枢。面向 A 股/中国宏观，默认中文界面。研究结论仅为流程演示，不构成投资建议。

## 它长什么样

```text
  浏览器面板（三栏：任务线 / 账本流水 / 泳道图）
        │  HTTP + 轮询
  Broker（零依赖 Node）：锁队列 · 版本 CAS · 门禁 · 复核 · 账本 · 面板托管
        │  desk CLI（唯一写入口）
  每名员工 = 独立 dsh headless 会话（自己的上下文 / 自己的模型 / 自己的知识库）
        │
  vault/<case>/  研究产物      runtime/ledger/events.jsonl  全部事件
```

## 快速开始

依赖：**Node.js ≥ 18**；员工真正跑起来还需要 **DeepSeek Harness（dsh CLI）** 和模型凭据；取数需要网络。

```bash
node scripts/init-worktree.js --demo   # 建运行目录，可选放一个 demo case
./start.sh                             # 面板 http://127.0.0.1:7801/live
```

启动后顶部会出现**环境自检**：缺 `dsh` / Node / 配置 / 目录权限时直接列出修法，点「重新检查」即可。没有 DSH 也能打开面板浏览账本、泳道、交付物；只是员工无法启动。

### Windows

- 用 `start.cmd` 启动（或在 cmd 里运行），不需要 WSL；核心面板/账本只用 Node。
- DSH 用 npm 全局安装时通常是 `dsh.cmd`，`start.cmd` 会自动找；也可以设 `DSH_BIN`。
- 解析 xlsx/pdf 需要在 PATH 里有 `python`（`pip install openpyxl pypdf`），或设 `PYTHON`。
- 自检会把缺失项标出来；`/api/doctor` 也返回同样结果。

首次使用没有预置模型：打开面板 → 左下角「模型配置」→「＋ 新建模型配置」，填一个 OpenAI 兼容网关（Base URL / 协议 / `env:YOUR_API_KEY`），保存并应用，然后点左侧员工派活。

补数据不用改代码、也不用走 DSH 对话：面板中栏「＋ 上传资料」把 CSV/Excel/PDF/图片放进 `vault/uploads/`（左栏「资料 · 面板上传」可预览/下载），员工下一轮的提示词里会自动看到附件清单；Excel/PDF 由 `scripts/extract.js` 转成文本后再读（xlsx→CSV、pdf→text）。

完整步骤（跨机器访问、口令、模型凭据、常见故障）见 **[docs/QUICKSTART.md](docs/QUICKSTART.md)**。

### 开源仓库配置

仓库不包含任何真实账密、API Key 或用户研究数据。首次运行：

```bash
cp .env.example .env          # 填自己的模型/数据源 key，不要提交
cp config/desk.json config/desk.local.json  # 本地端口/模型配置，已被 gitignore
```

凭据放在 `.env` 或 `runtime/secrets/`；提交前请阅读 **[SECURITY.md](SECURITY.md)**。

## 自定义（不改代码）

| 想改什么 | 改哪里 |
|---|---|
| **模型** | 面板「模型配置」（写进账本，重启恢复）；或 `config/desk.json` 的 `models` |
| **提示词** | `agents/<role>/ROLE.md`、`AGENTS.md`，共享规则 `agents/_COMMON.md`（下一轮生效） |
| **技能** | 加目录 `skills/<id>/SKILL.md`（frontmatter：`name/description/version/category`），重启即出现在技能库；用 `config/desk.json` 的 `skills.assign` 配默认装配，或在面板里单独装配 |
| **角色名单** | `config/desk.json` 的 `agents`（加一个角色 = 加一条 + 建 `agents/<id>/ROLE.md`） |
| **案例默认** | `config/desk.json` 的 `case`（默认参与角色 / 受众 / 期限） |
| **运行参数** | `config/desk.json` 的 `server`；或启动参数 `--port/--host/--token/--root`、环境变量 `DSH_BIN` |

本机私有配置写 `config/desk.local.json`（已 gitignore，覆盖 `desk.json` 同名键）。

## 目录

| 路径 | 作用 |
|---|---|
| `runtime/server/broker.js` | 零依赖 Broker：锁队列 / 版本 CAS / 账本 / 门禁 / 面板与 API |
| `dashboard/` | 面板（`template.html` → `build.js` → `mockup.html`，Broker 直接托管） |
| `runtime/agents/employee.js` | 起一名员工的独立 dsh headless 会话 |
| `scripts/desk` | 员工唯一写入口 CLI（acquire / write / gate / need / review / kb …） |
| `scripts/pipeline.js` | 按 DAG 串角色跑一轮 |
| `agents/` | 角色卡（`ROLE.md`）与共享协议（`_COMMON.md`） |
| `skills/` | 技能目录（每个 `SKILL.md` 一份） |
| `config/desk.json` | 角色 / 模型 / 技能装配 / 端口等运行配置 |
| `vault/` | 每个 case 的研究产物（gitignore） |
| `runtime/ledger/events.jsonl` | 账本（事件溯源，面板唯一数据源；gitignore） |
| `docs/` | 设计与里程碑（DESIGN.md、M1–M8、QUICKSTART.md） |

## 数据与安全边界

- 研究数据（`vault/`）、账本（`runtime/ledger/`）、历史版本、知识库、运行日志全部 gitignore，**仓库里只有代码、提示词、技能模板和配置**。
- 模型凭据只以 `env:` / `keychain:` 引用形式存在配置与账本里，面板拒收明文 Key。
- 默认只监听 `127.0.0.1`；`--host 0.0.0.0` 时请配 `--token`（口令只拦网络来源，本机进程免口令）。
- 当前定位是**单机、单用户**工作台，没有多租户与细粒度权限；不要直接暴露到公网。

## 已知边界

- 员工运行时依赖 DeepSeek Harness（`dsh`），没有它就只剩看板。
- 取数脚本**免费源优先**（商务部 / 东方财富 / 中国货币网 / FRED / 中债 / 统计局），Tushare 仅作可选 provider（需积分）；没有 Tushare 积分也可用免费源或上传 CSV。详见 [docs/CONNECTOR-SPEC.md](docs/CONNECTOR-SPEC.md) 与 [docs/DATA-SOURCE-MATRIX.md](docs/DATA-SOURCE-MATRIX.md)。
- 从网址识别数据：`node scripts/collect.js site <URL>` 会渲染页面、跟统计/详情链接、下载 XLS/PDF 并转 CSV；需要自主点 tab/跟链接/找附件时用 `python3 scripts/web_agent.py --url <URL> --goal '<板块/数据>'`（Tool Gateway 里是 `web.agent`），由模型自己决定浏览路径；图片 OCR 只作兜底。详见 [docs/WEB-DATA-INTAKE.md](docs/WEB-DATA-INTAKE.md)。
- 缺口数据补齐走专用 DataTask：缺口弹窗点“用模型补齐”，填 URL/文件；模型在来源策略和预算内解析，逐项 coverage/quality 门禁通过后，用户确认才事务写入 evidence/need。详见 [docs/DATA-TASK.md](docs/DATA-TASK.md)。
- 双层有界 super-agent（Lead 编排 + WorkItem 驱动的员工循环）与 Tool Gateway 见 [docs/AGENT-LOOP.md](docs/AGENT-LOOP.md)；普通 DAG 节点默认由 run-dag 调度、Employee Loop 执行（`scheduler.useAgentLoop`，含 modelChain 逐阶段）；支持 dsh / openai-compatible / fake 三种 Agent Runtime、确定性输出门禁、case 预算预留 + WorkItem token 上限、结构化审批、trace 下钻与 loop 重放、autonomy levels；Lead 的高风险动作（取消任务/装配报告）必须结构化人工审批（need decision=approve + approvalToken），且只装配不签发。
- 新建 case 只需名称 + 一句话研究目标：`scripts/case-intent.js` 先抽标的/类型，模糊时面板再用选项确认；mission.md 会同步写入，避免员工反复报 mission 缺口。
- 并行派活点击「开始并行」即关闭弹窗并自动批准计划；macro / industry / stock 三个主研究员工并行启动，stock 的预研节点先跑，估值/结论/风险/可视化等收口节点通过 `waitForPlans` 等 macro/industry 完成；audit / legal / trader 不生成并行任务计划。
- 右栏顶部是「需要你处理」问题导航，聚合待批计划、待补数据、复核、冲突、报告流水线、数据源异常、Agent 循环等；点一下直接展开并定位。二级面板收进「研究与交付 / 数据与证据 / 执行与运维」三组，不再一排下拉框。
- 模型目录里只有 `opencode-go/deepseek-v4.1-flash` 是实测标记；自建 OpenAI 兼容网关可直接接入并试跑，跑通后自动标记「已实测」。
- 复核（审计/法律）与签发是流程演示，不替代真实合规审查。

## 开发

```bash
cd dashboard && node build.js && node test.js     # 面板 202 项检查
node runtime/server/test/run.js                   # Broker 18 项检查
node scripts/test-source-chain.js                 # 数据源分层/免费优先 fallback（15 项，不联网）
node scripts/test-data-quality.js                 # 数据质量门禁（11 项，不联网）
node scripts/test-data-crosscheck.js              # 多源交叉校验（6 项，不联网）
node scripts/test-connectors.js                   # 免费 connector 真实联网（FRED 无 key 自动 SKIP）
node scripts/test-data-pipeline.js                # 自动采集→证据→质量门禁（需 broker）
node scripts/test-report-freshness.js             # 报告 dataAsOf→签发 409→acceptStale（需 broker）
node scripts/test-datatask.js                     # DataTask 契约/覆盖/门禁/来源策略（25 项，不联网）
node scripts/test-datatask-flow.js                # DataTask 创建→解析→确认→关闭（临时 broker）
node scripts/test-datatask-worker.js              # DataTask 文件 worker（临时 broker）
node scripts/test-datatask-restart.js             # DataTask 重启对账（临时 broker）
node scripts/test-agent-loop.js                   # 双层 Agent Loop + Tool Gateway（需 broker）
node scripts/test-workitem-loop.js                # WorkItem claim → gate → finish（需 broker）
node scripts/test-lead-actions.js                 # Lead 扩展动作 + 审批边界（需 broker）
node scripts/test-dag-loop.js                     # run-dag → Employee Loop → gate → finish（需 broker）
node scripts/test-budget-reservation.js           # 预算预留/释放/超限 fail-closed（独立临时 broker）
node scripts/test-openai-runtime.js               # OpenAI-compatible function calling（mock 网关）
node scripts/test-openai-opencode.js               # opencode-go 真实网关 + function calling
node scripts/test-mcp-server.js                   # MCP server 冒烟（需 broker；当前暂停接入）
```

## English

AlphaDesk is a self-hosted, observable multi-agent investment-research workflow: six AI employees collaborate on one case, all file writes go through a broker with lock queues and version CAS, and a live panel projects an append-only event ledger into a swimlane view.

Requirements: Node.js ≥ 18; DeepSeek Harness (`dsh`) if you want agents to actually run; network for market data. Run `node scripts/init-worktree.js --demo && ./start.sh`, then add a model in the panel (no model is preconfigured). Prompts, skills, agent roster and port are all configurable via `agents/*.md`, `skills/*/SKILL.md` and `config/desk.json`. Data (`vault/`, `runtime/ledger/`) is gitignored. See [docs/QUICKSTART.md](docs/QUICKSTART.md).

## License

[Apache-2.0](LICENSE)。
