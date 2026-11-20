# QUICKSTART · 换台机器跑起来

本文只讲"怎么在另一台电脑上把它跑起来、自己配模型"。设计原理见 [DESIGN.md](DESIGN.md) 与 M1–M8。

## 1. 三种独立程度（先看清楚再动手）

| 级别 | 需要什么 | 能做到什么 |
|---|---|---|
| 只看板 | Node.js 18+ | 打开面板、看历史账本、看泳道图、改模型/技能配置、看交付物 |
| 看板 + 派活 | Node.js + DeepSeek Harness（dsh）+ 至少一个 dsh 可调用的模型 | 员工真的跑起来，写底稿、写证据池、过门禁 |
| 跨机器访问 | 上面两项 + `HOST=0.0.0.0` + `PANEL_TOKEN` | 别人的浏览器/手机也能看同一份账本 |

**没有 dsh 也能看板**，但派活会直接失败：面板右上会显示「未找到 dsh · 员工无法启动」。

## 2. 依赖

| 依赖 | 必需性 | 说明 |
|---|---|---|
| Node.js ≥ 18 | 必需 | Broker 零依赖，只用内置模块 |
| DeepSeek Harness（dsh CLI） | 员工必需 | 员工的运行本体；`DSH_BIN` 可指定路径，否则按 PATH → macOS App 路径找 |
| 模型 provider 凭据 | 员工必需 | 由 dsh 实际使用的 provider 决定：key 放环境变量或 `~/.dsh/.credentials.yaml`；**面板不会保存明文** |
| 网络 | 取数时必需 | `scripts/market` 走新浪/东财/Tushare |
| Tushare token | 可选 | `runtime/secrets/tushare.json`（chmod 600，已 gitignore）；没有就取不到 Tushare 数据 |

## 3. 启动

```bash
node scripts/init-worktree.js --demo   # 首次运行：建目录 + 可选 demo case
./start.sh                             # 默认只听 127.0.0.1，不需要口令
# 面板 http://127.0.0.1:7801/live
```

`start.sh` 会自动加载根目录的 `.env`（已 gitignore），也可以直接 `export`。  
最小配置是：

```bash
cp .env.example .env
# 按你实际使用的 provider 填 key
./start.sh
```

`config/desk.json` 里的 opencode-go 只是示例默认值，不是硬性要求。  
只要你用的 provider/model 已经在 dsh 里能正常调用，在面板模型配置里填同一组 provider/model 即可；  
自建 OpenAI 兼容网关再补 base_url。

## 3.5 可配置项（config/desk.json）

开源版不把产品默认值写死在代码里，以下都在 `config/desk.json`：

| 键 | 作用 |
|---|---|
| `brand` / `language` | 面板品牌名、界面语言（当前仅 zh） |
| `server.port` / `server.host` | 默认端口与监听地址（仍可用启动参数覆盖） |
| `agents` | 角色名单：`id / name / glyph / tier / role`（`role` 为 ROLE.md 路径；`lead` 的 role 为 null） |
| `case` | 新 case 默认参与角色、受众、期限 |
| `models.default` / `models.catalog` | 预置模型；**开源默认是 null + 空目录**，由用户自己在面板加 |
| `skills.dir` / `skills.assign` | 技能目录（默认 `skills`）与每角色默认装配 |
| `dsh.bin` | dsh 路径（等价 `DSH_BIN`） |

本机私有覆盖写 `config/desk.local.json`（已 gitignore，同名键覆盖 `desk.json`）。

也可以直接起 Broker（等价）：

```bash
node runtime/server/broker.js --port 7801 --host 127.0.0.1
```

换端口：`PORT=7810 ./start.sh`。

## 4. 跨机器 / 局域网访问（必须配口令）

```bash
HOST=0.0.0.0 PANEL_TOKEN='换成你的口令' ./start.sh
# 浏览器：http://<这台机器的局域网IP>:7801/live?token=换成你的口令
```

- 第一次带 `?token=` 进来后，Broker 会种一个 HttpOnly cookie 并把你跳到不带口令的地址，地址栏不留口令。
- 之后也可以直接访问 `/login` 输入口令。
- **安全边界**：口令只拦"网络来源"。本机回环进程（员工、`scripts/desk`、`pipeline.js`）默认免口令；如果前面挂了反向代理、需要连本机也验口令，加 `--trust-loopback 0`（此时员工请求也要带口令，一般只在代理场景用）。
- 没设 `PANEL_TOKEN` 又开了 `HOST=0.0.0.0`，`start.sh` 会告警：那等于把账本、文件下载、派活接口敞开给同网段。

## 5. 模型怎么配（以及现在真正能跑什么）

面板左下角「模型配置」可以（开源默认**不预置任何模型**；作者自己的环境可写进 gitignored 的 `config/desk.local.json`）：

> 下面出现的 `opencode-go/deepseek-v4.1-flash` 只是示例，不是唯一支持项。  
> 只要 dsh 能正常调用你的 provider/model，就在面板里配置同一组 provider/model；  
> 需要自建网关时再填 Base URL。

- 改**全员默认模型**；
- 给**单个员工**指定模型（写入账本 `model.changed`，重启后回放恢复）；
- 增删模型目录条目 —— 凭据只接受 `env:XXX` / `keychain:XXX` 引用，**不接受明文 Key**。

面板里的「新建模型配置」现在能直接把一个自建网关接进员工运行时（写入 `runtime/profiles/<agent>.yml` 的 pi-ai 手写路由）。填法是：

| 字段 | 填什么 |
|---|---|
| Provider | 路由名，如 `acme`（员工按这个名字选模型） |
| 模型 ID | 网关侧的模型 id，如 `acme-think` |
| Base URL | `https://gateway.example/v1`（有它才会生成手写路由） |
| 接口协议 | `openai-completions`（默认）/ `openai-responses` / `anthropic-messages` |
| API Key | 只填引用：`env:ACME_API_KEY`（值走环境变量或 `~/.dsh/.credentials.yaml`） |
| 上下文窗口 | 网关模型的 contextWindow，如 128000 |

当前状态：

| 目录条目 | 能不能真跑 | 说明 |
|---|---|---|
| `opencode-go/deepseek-v4.1-flash` | 能（已实测） | `verified: true` |
| 其它内置模型 | 不能 | `verified: false` 且没有 Base URL，面板标「未接入」 |
| 自建 provider（填了 Base URL） | 能试跑 | 面板标「可试跑」；跑通一轮后 employee.js 会回调 `/api/model/verified`，标记变「已实测」 |

实测验证：用 `http://127.0.0.1:9/v1`（关闭的端口）建 `acme/acme-think`，dsh 正常接受手写路由并在 `459ms` 内返回 `TRANSPORT Connection error`——说明 patch 语法与字段是对的，剩下只是网关连通性。

两个已知坑：

- **不要给自建路由发推理档位**：未在 `models.reasoningEfforts` 里声明就发 `reasoningEffort: high`，dsh 会回 `UNSUPPORTED_REASONING_EFFORT`（已在实测踩到，现在自建路由默认不发）；
- `keychain:XXX` 这种引用映射不成 dsh 的 `apiKeyEnv`（它只认 POSIX 标识符），请写 `env:XXX` 或裸名字。

## 6. 员工怎么被拉起

```text
面板派活 → POST /api/agent/run → node runtime/agents/employee.js --agent X --case Y --task "..."
        → 读 /api/models 里该员工的模型 → 写 runtime/profiles/X.yml
        → dsh --patch runtime/profiles/X.yml --profile headless --json "<任务书>"
        → 员工用 ./scripts/desk 读写 vault（锁 + 版本 CAS + 账本）
```

自检（不需要凭据）：

```bash
node runtime/agents/employee.js --agent macro --case case-2026-002 --task 测试 --dry-run
```

## 7. 数据在哪、怎么备份/迁移

| 路径 | 内容 |
|---|---|
| `runtime/ledger/events.jsonl` | 全部账本事件（面板唯一数据源，append-only） |
| `vault/<case>/` | 每个 case 的研究产物与终稿 |
| `runtime/history/<case>/` | 每次写入的历史版本 |
| `runtime/kb/<agent>/` | 每个员工自己的 Wiki |
| `runtime/secrets/` | Tushare token（**不要外传**） |
| `runtime/profiles/`、`runtime/dsh-home/` | 运行期生成，可删 |

备份/迁移 = 拷贝整个目录（不含 `runtime/secrets/`，到新机器再放一份）。

## 8. 常见故障

| 现象 | 原因 / 处理 |
|---|---|
| 面板右上「未找到 dsh · 员工无法启动」 | 没装 DeepSeek Harness；`DSH_BIN=/path/to/dsh ./start.sh` |
| 派活后 `找不到 <KEY_ENV>` | 按模型配置里的 key_ref 设置对应环境变量，或写进 `~/.dsh/.credentials.yaml` 的同名 ref |
| `模型未接入运行时` | 选的是 `verified:false` 且没填 Base URL 的模型；换成 dsh 已实测可用的模型，或给自建模型补 Base URL |
| 派活后 `TRANSPORT / Connection error` | 自建网关连不上：检查 Base URL、端口、网络；patch 已经生成（`runtime/profiles/<agent>.yml`） |
| `UNSUPPORTED_REASONING_EFFORT` | 自建路由不支持推理档位；当前实现已对自建路由不发 `reasoningEffort`，若仍出现，检查是否手改过 profile |
| 局域网打不开 | 没用 `HOST=0.0.0.0`，或防火墙拦了端口；用 `--host 0.0.0.0` 且带 `?token=` |
| 401 `/api/...` | 口令没带：用 `/login` 或 `?token=`（本机访问不该出现；出现说明用了 `--trust-loopback 0`） |
| 端口占用 | `PORT=7810 ./start.sh`，或先 `lsof -ti tcp:7801 \| xargs kill` |

### 面板上传本地资料（员工可直接使用）

监督者通过面板中栏「＋ 上传资料」把本地文件传进 `vault/uploads/`（40MB 以内），不需要经过 DeepSeek Harness 对话：

| 类别 | 面板 | 员工读取方式 |
|---|---|---|
| CSV / JSON / MD / TXT | 直接文本预览 | `desk cat --path uploads/xxx.csv` |
| Excel (.xlsx/.xls) | 面板自动转 CSV 预览 | `node scripts/extract.js --case <case> --path uploads/xxx.xlsx` |
| PDF | 面板自动转文本预览（需 pypdf/PyPDF2/pdfminer） | 同上，`extract.js` 转文本 |
| 图片 PNG/JPG | 面板内预览 | 只能看元数据；要数字请补 CSV/文字 |

- 上传后：左栏「资料 · 面板上传」列出全部附件（版本/大小），点击可预览、下载；账本记 `file.uploaded`；
- 员工启动时提示词里自动出现「本轮可用附件」清单（路径 + 版本），并要求把用到的数字写进 `evidence/sources.jsonl`、标 `[S#]`；
- 示例命令：`node scripts/gen-image.js ...` 与上传无关；上传用面板按钮或 `desk upload --file x --path uploads/x`。
