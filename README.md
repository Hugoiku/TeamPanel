# 天枢 · 边界智能投研 Agent

> HugoTeam 天枢 · 投研工作流中枢  
> 让模型在边界内做更复杂的判断，让系统在边界外做更可靠的交付。

天枢不是给聊天窗口加几个按钮，而是把投研工作拆成一条可监督、可恢复、可复现的工作流：

~~~text
Case → Plan → WorkItem → Employee Loop → Gate → Evidence → Report → Sign → Verify
~~~

6 名 AI 员工 + 1 个 Lead 在同一份 case 上协作。员工的文件读写走 Broker 的锁队列与版本 CAS，全过程写入 append-only 账本；面板从账本投影出“谁在做什么、交付了什么、卡在哪”。

> 面向 A 股/中国宏观，默认中文界面。研究结论仅为流程演示，不构成投资建议。

## 与单 Agent 对话、普通 DeepSeek Harness 的区别

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

普通 DeepSeek Harness 是通用 Agent 执行底座，强在工具、文件和长任务执行；  
单 Agent 对话强在低门槛；  
天枢在两者之上增加投研工作流治理：任务契约、数据证据、失败恢复、报告签发与复现。

## 当前 Panel 能力

| 能力 | 说明 |
|---|---|
| CaseView | 把 case 状态投影成“当前阶段 + 主按钮 + 阻塞项 + 质量摘要” |
| 七阶段 | 准备 → 待批准 → 执行中 → 待补数据 → 待复核 → 待签发 → 完成 |
| 对象状态 | Evidence / Claim / Brief / Report 是否可信、是否过期、是否冲突 |
| 证据来源 | URL / 文件 / connector / derived，不再把所有来源都当成 URL |
| 文件证据 | 显示文件名；读取时计算并展示 sha256，避免只显示空白 URL |
| 知识视图 | 只读知识检索，员工可查已有证据/claim，但不能自行提升或改权限 |
| Lead 恢复 | 单 Lead 租约、心跳、resume、takeover、failureKind |
| 报告交付 | 复核、签发、verify，报告 artifact 路径集中管理 |
| 缺口闭环 | need 是唯一缺口对象；待补 / 部分补齐 / 已豁免；DataTask 作为执行记录嵌在缺口详情里 |

> 当前知识层是只读视图，不是完整候选/验证知识池；完整知识治理仍属后续阶段。

## 交给 DeepSeek Harness Agent 自动部署

如果你不想手动敲命令，可以把下面这段直接交给具备 shell / 网络权限的 DeepSeek Harness Agent。  
目标不是“把仓库 clone 下来”，而是“配置到 Panel 能正式启动员工”。

### 部署提示词

~~~text
你是天枢 Panel 的部署 Agent。目标：把 https://github.com/Hugoiku/TeamPanel
部署到本机，并验证到“Panel 可启动、员工可运行”的正式使用状态。

硬约束：
1. 不要伪造 API Key，不要把 Key 写进 README、Git、日志或聊天记录。
2. 不要提交 .env、vault/、runtime/secrets/。
3. 每一步先检查现状，不要重复 clone / 覆盖已有 .env。
4. 如果缺少 shell、网络、dsh 或模型凭据，停下来向用户报告缺什么。

执行步骤：
1. 检查 node >= 18、git、dsh --version、当前目录权限。
2. clone 仓库；如果已存在，先 git status / git pull，不要覆盖用户改动。
3. 进入项目，执行 node scripts/init-worktree.js --demo。
4. 确认“用户当前能用的模型”，不要假设 provider：
   - 先看 dsh 实际能调用哪个 provider / model；
   - 如果用户已说明，按其 provider / model / base_url / key 配置；
   - 如果 DSH 依赖账号登录而不是环境变量，先用 dry-run 验证 Panel 子进程能否复用；
   - 需要 key 时，让用户把 key 写入 .env 的对应变量，不要打印值。
5. 在 Panel 模型配置里写入与 DSH 一致的那一条：
   - provider、model 必须与 dsh 可用模型一致；
   - 自建/provider 需要 base_url 时填 base_url；
   - key_ref 用 env:YOUR_KEY_NAME，不写明文；
   - 如果 config/desk.json 的示例模型不是用户可用模型，改 config/desk.local.json 或面板默认模型，不要改源码默认值。
6. 确认 dsh 可用；如果不在 PATH，设置 DSH_BIN 为实际绝对路径。
7. 启动：./start.sh；如果端口占用，使用 PORT=7802 ./start.sh。
8. 验证：
   curl -s http://127.0.0.1:7801/api/health
   curl -s http://127.0.0.1:7801/api/doctor
   curl -s http://127.0.0.1:7801/api/models
9. 运行 dry-run：
   node runtime/agents/employee.js --agent macro --case case-demo --task "部署验收" --dry-run
10. 如果模型可用，再跑一个最小真实任务；失败则保留错误原文，不要假装成功。
11. 最后报告：
   - 本地 URL
   - doctor 哪些项通过/失败
   - 实际使用的 provider / model
   - 是否达到“可正式使用”
   - 还缺什么（dsh / 模型 / 数据源 / Python）

重要：
部署 Agent 自己的模型调用权限，不等于 Panel 员工的模型凭据。
Panel 员工由 dsh 子进程启动，必须使用 dsh 真正能调用的 provider/model；
不要假设一定是 opencode-go，也不要假设任何固定 provider。
如果唯一可用的 provider 需要额外 key，让用户提供，不能伪造。
~~~

### 正式使用的最低验收

Agent 报告“完成”前，至少满足：

~~~text
Node.js >= 18
dsh 能找到
/api/health 返回 ok
/api/doctor 中 node / dsh / config / vault 通过
/api/models 里至少有一条与用户 DSH 实际可用模型一致的条目
dry-run 能启动员工进程
用户能给一个 case 派活并看到 agent.run.started
~~~

只满足“页面能打开”不算正式使用。

### 不建议让 Agent 自动做的事

~~~text
不要让 Agent 猜 API Key
不要让 Agent 把 .env 内容输出到聊天
不要让 Agent 自动提交 vault/ 或 runtime/secrets/
不要让 Agent 直接暴露 HOST=0.0.0.0 到公网
~~~

需要远程访问时，让用户自己设置：

~~~bash
HOST=0.0.0.0 PANEL_TOKEN='用户自己的口令' ./start.sh
~~~

## 使用前提

### 1. 只看 Panel（最小前提）

需要：

~~~text
Node.js ≥ 18
仓库代码
可写目录
现代浏览器
~~~

不需要 DeepSeek Harness、模型 Key、Python、数据库或 Redis。

~~~bash
git clone <repo-url> TeamPanel
cd TeamPanel
node scripts/init-worktree.js --demo
./start.sh
~~~

可以打开面板、看 demo/历史账本、泳道图、交付物。  
不能启动员工、自动采集数据或自动生成报告。

### 2. 派活、跑员工

在最小前提上增加：

~~~text
DeepSeek Harness（dsh CLI）  必须
至少一个 DSH 可调用的模型     必须
可访问模型 API 的网络        必须
~~~

- dsh 要出现在 PATH，或通过 DSH_BIN 指定路径；
- 没有 dsh 时面板仍能打开，但员工无法启动，顶部会提示「未找到 dsh」；
- Panel 不限定 provider：opencode-go、DeepSeek、Anthropic、OpenAI 兼容网关等，只要 dsh 真正能调用即可；
- 模型凭据放在 .env 或 ~/.dsh/.credentials.yaml，不要提交到仓库。

首次启动后：面板左下角「模型配置」→ 选择或新建与 dsh 实际可用模型一致的条目 → 保存并应用。  
如果仓库示例默认值不是你用的 provider，改 config/desk.local.json 或面板默认模型，不要改源码默认值。

### 3. 数据采集与报告

- 网络：访问模型 API 与目标数据源；
- 可选数据源凭据：Tushare 积分、FRED key 等；没有就用免费源或上传 CSV；
- 可选 Python 3：xlsx/pdf 解析需要 openpyxl / pypdf，docx 报告需要 python-docx；
- 第三方数据 license 的报告使用范围由使用者确认。

### 4. 使用限制

- 单机、单用户，没有多租户/RBAC；
- 不要直接把 Broker 暴露到公网；远程访问需要 --token + 可信网络；
- 无需数据库/Redis，但运行数据会写入 runtime/ 和 vault/；
- 模型 token 与付费数据费用由使用者承担；
- 审计/法务结论不替代真实合规审查。

## 如何使用

### 第一步：启动

~~~bash
cp .env.example .env
cp config/desk.json config/desk.local.json

node scripts/init-worktree.js --demo
./start.sh
~~~

打开：

~~~text
http://127.0.0.1:7801/live
~~~

Windows 使用 start.cmd；DSH 通常是 dsh.cmd，也可以设置 DSH_BIN。

### 第二步：建 case、派活

在面板里新建 case，输入研究目标。Lead 会生成计划：

~~~text
待批计划 → 人工批准 → WorkItem 拆解 → 员工执行
~~~

计划批准后，run-dag 按依赖顺序执行；三栏面板会显示任务、心跳、门禁和失败原因。

### 第三步：补数据、处理失败

- 数据缺口：补 URL/文件，或走 DataTask；
- 失败节点：重试、修契约、拆分（拆分需人工确认）；
- 卡住：顶部告警条会显示是 run-dag 退出、心跳超时还是 loop 无进展；
- 继续执行：会先恢复 failed/cancelled 节点，再启动 run-dag。

### 第四步：报告、签发、复现

~~~text
报告装配 → 引用/数字一致性 → 审计/法务复核 → 数据新鲜度/license → 签发
~~~

签发后可执行：

~~~bash
node scripts/verify-report.js --case <case>
~~~

检查报告 sha、manifest、签名、证据 snapshot 是否可追溯。

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

## 证据与来源

证据不要求一定有 URL。来源可以是：

~~~text
url        网页 / 官方 API
file       用户上传文件
connector  Tushare / 中债 / 统计局等
derived    由其他证据计算得出
~~~

文件证据没有 URL 是正常的，但应显示：

~~~text
文件名
sourceType
sha256
入库时间
~~~

当前面板会在读取文件证据时计算 sha256 并标注“现算”；  
长期应在上传入库时持久化 hash，并让报告 verify 逐文件校验。

## 安全

- 真实 key 只放在 .env 或 runtime/secrets/；
- vault/、drafts/、runtime/ 默认不提交；
- config/desk.local.json 已被 gitignore；
- 详细规则见 [SECURITY.md](SECURITY.md)。

## 已知边界

- 单机、单用户；没有多租户 / RBAC / 高可用；
- 知识层当前只读，不做完整 candidate/verified 知识池；
- 不做事件驱动控制面；
- 不做 section 级缓存失效；
- 文件证据的 hash 目前在读取时计算，尚未全部持久化；
- 已签发报告若在标题/内容修复前生成，需要重新生成、复核、签发才会更新。

## 当前状态

~~~text
数据采集：单团队生产级
任务规划 / 员工执行：生产 beta
报告闭环 / 连续 case 验证：仍在推进
整体定位：单用户投研工作台，生产 beta
~~~

## 文档

- [docs/QUICKSTART.md](docs/QUICKSTART.md)：启动、模型、凭据、跨机器访问
- [docs/DESIGN.md](docs/DESIGN.md)：整体设计
- [docs/AGENT-LOOP.md](docs/AGENT-LOOP.md)：双层有界 Agent / WorkItem
- [docs/DATA-COLLECTION.md](docs/DATA-COLLECTION.md)：数据采集与 DataGateway
- [docs/DATA-TASK.md](docs/DATA-TASK.md)：缺口补齐

## License

[Apache-2.0](LICENSE)
