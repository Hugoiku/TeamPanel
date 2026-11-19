# Connector 泛用性规范（免费优先 / 可选积分源）

> 目标：把面板放到 GitHub 开源后，**没有 Tushare 积分账号的人也能用**。
> 原则：免费公开源优先；积分/账号源只做可选 provider；不可用时必须明确降级（上传 CSV 或配置免费 Key），不能把“必须充值/攒积分”当成默认路径。

## 1. 数据源分层

每个来源在 `config/data/sources.json` 里用 `access` 声明能力层级：

| tier | 含义 | 例子 | 默认可用 |
|---|---|---|---|
| `free` | 公开接口，无需 token | 商务部社融、东方财富、中国货币网、中债/统计局 | ✅ |
| `free-key` | 免费注册 key，无付费/积分门槛 | FRED API key（免费申请） | 配 key 后 |
| `token` | 需要 token，但不要求积分 | 预留 | 配 token 后 |
| `credit` | 需要 token **且**积分/权限 | Tushare 宏观接口（≥2000 积分） | 可选，不默认依赖 |
| `account` | 需要账号登录/付费 | Mysteel、SMM、猫眼、灯塔、QuestMobile | ❌ 默认不启用 |

示例：

```json
{
  "id": "mofcom-tsf",
  "name": "商务部 · 社会融资规模增量",
  "configSource": "mofcom-tsf",
  "capabilities": ["macro.tsf"],
  "structured": true,
  "access": {
    "tier": "free",
    "auth": "none",
    "homepage": "https://data.mofcom.gov.cn/gnmy/shrzgm.shtml",
    "probe": {
      "method": "POST",
      "url": "https://data.mofcom.gov.cn/datamofcom/front/gnmy/shrzgmQuery",
      "contains": "tiosfs"
    }
  }
}
```

Tushare（可选积分源）：

```json
{
  "id": "tushare-cn-m1",
  "access": {
    "tier": "credit",
    "auth": "token",
    "minPoints": 2000,
    "secret": "runtime/secrets/tushare.json",
    "env": ["TUSHARE_TOKEN"],
    "homepage": "https://tushare.pro",
    "probe": {
      "type": "tushare",
      "api": "cn_m",
      "params": { "start_m": "202601", "end_m": "202601" },
      "fields": "month,m1_yoy"
    }
  }
}
```

## 2. 指标 → 来源 fallback 链

- `metric.sources` 数组顺序 **就是** fallback 顺序：免费源在前，可选积分/账号源在后；
- 没有显式 `sources` 时，按 `capabilities` 匹配 + `priority` 排序；
- 只保留结构化来源（`structured !== false`），`draft` 来源跳过；
- `scripts/source-chain.js` 的 `buildChain(metric, sources)` 返回：

```json
{
  "chain": ["mofcom-tsf", "tushare-sf-month"],
  "skipped": [{ "id": "tushare-sf-month", "reason": "未配置凭据：...", "tier": "credit" }]
}
```

- 链为空 → `item.auto.status = "no_source"`，`reason` 里列出每个被跳过来源的原因，并提示上传 CSV/配置免费凭据；
- 链非空 → 创建 data job，`sourceId=chain[0]`，`sourceChain=[...]`。

## 3. 健康检测

`scripts/source-health.js`：

- `staticCheck(source)`：不联网，只检查 `access.tier` 与凭据（secret 文件 / 环境变量）；
- `probeSource(source)`：按 `access.probe` 联网探测；Tushare 用真实 API 调一次，`40203` 明确标记“积分/权限不足”；
- 结果缓存 `runtime/data/source-health.json`（默认 6 小时），`getHealth()` 优先采用“明确不可用”的缓存；
- 失败闭环：data-worker 遇到 `40203/积分/权限` 会立即 `markUnavailable()`，后续任务不再反复撞墙。

CLI：

```bash
node scripts/source-doctor.js --list        # 静态 + 缓存
node scripts/source-doctor.js --refresh     # 联网探测全部
node scripts/source-doctor.js --refresh --id mofcom-tsf
```

API：

| 接口 | 作用 |
|---|---|
| `GET /api/data/source-health` | 返回每个来源的 `available/tier/reason/checkedAt` |
| `POST /api/data/source-health/refresh` | 后台启动体检，5–20 秒后重新 GET |

面板右栏「数据源」手风琴展示：免费可用 / 需配置 / 可选积分三组，以及缺什么、去哪申请。

## 4. 执行期 fallback

`scripts/data-worker.js` 按 `sourceChain` 顺序执行：

```text
for source in sourceChain:
  static/health check → 不可用则记录 attempt 并跳过
  collect(source) → 成功且 records 非空 → 采用
                  → 失败/空 → 记录 attempt，试下一个
全部失败：
  attempts < maxAttempts → queued（broker 5s 后重拉 worker）
  attempts >= maxAttempts → failed → 建“请手动上传数据”缺口
```

- job 上保存 `sourceChain / sourceAttempts`；
- 发生换源时写账本 `data.job.fallback`（from/to/attempts）；
- `item.auto.reason` 保留最终失败原因，面板“待补数据”直接显示；
- 旧字段 `fallbackSource` 仍兼容，但新逻辑统一走 `sourceChain`。

## 4.1 自动采集证据化（2026-11）

自动采集成功后，broker 会为 data job 生成一条 `S#` 证据，写入 `vault/<case>/evidence/sources.jsonl`：

- `url`：来源主页 / job URL；
- `field`：指标名 + 区间；
- `value`：metric/sourceId/range/first/last/count/latest；
- `raw`：`runtime/data/raw/<job>.json` 原始快照；
- `sha256`：raw 文件哈希；
- `note`：来源、coverage、数据截至、质量门禁结论；
- `auto: true`、`jobId`。

同时：

- `item.evidenceId = S#`，need 答复里写「证据：[S#]」；
- 账本写 `data.job.evidence`（evidenceId/sha256/dataAsOf/qualityOk）；
- `need.auto` 事件携带 `evidenceId/dataAsOf`，重启回放不丢。

这样报告里的数字才能引用 `[S#]`，审计才能回查 raw snapshot。

## 4.2 数据质量门禁（2026-11）

`scripts/data-quality.js` 对自动采集 records 做确定性检查（不调用模型）：

| 检查 | 失败处理 |
|---|---|
| 非空 / period 格式符合频率 | `needs_review` |
| period 不重复 / 升序 | `needs_review` |
| 月度/季度周期连续 | `needs_review` |
| 单位与 metric 定义一致 | `needs_review` |
| 数据新鲜度（`maxStalenessDays/Months`） | `needs_review` |

- 任何失败都不会自动关闭缺口，`item.auto.reason` 写明原因，need stage 为 `quality_pending`；
- 数据截至（`dataAsOf`）会显示在缺口弹窗和报告/答复里；
- 阈值在 `config/data/metrics.json` 按指标配置，例如 LPR 45 天、SHIBOR 7 天、M1/M2 2 个月、社融 2 个月。

## 4.3 首次自检 / 运行前预检 / 缺口动作

- `GET /api/doctor` 新增 `data_sources` 可选检查：免费可用数、可选未配置数；不阻塞启动；
- 面板首次打开显示一次非阻塞「数据源」提示，可「查看数据源 / 知道了」；
- `GET /api/data/preflight?case=X`：把当前未补齐的数据缺口映射到来源链，返回 `ready/chain/skipped/reason`；
- 点击「启动执行」前先预检：有缺口时弹确认，可选择继续（转人工）或去配置；不会静默启动；
- 缺口弹窗的 `no_source/needs_review/failed` 项提供「数据源」按钮，直达右栏「数据源」；已有「传文件」按钮兜底。

## 4.4 凭据与自定义数据源配置（2026-11）

- `GET /api/data/credentials`：只返回 Tushare/FRED 是否已配置、路径、提示，不回显明文；
- `POST /api/data/credentials`：写入 `runtime/secrets/tushare.json` / `fred.json`（0600），保存后立即 probe；
  - Tushare 失败会标记全部 `tushare-*` 不可用，避免反复失败；
  - FRED 用免费 API key 探测 `DGS10`；
  - 账本写 `data.credentials.updated`（provider/configured/available/reason，无明文）；
- 面板右栏「数据源」→「配置凭据」弹窗：两个密码框，留空=不修改；保存并测试；
- 「添加数据源」弹窗：URL/名称/字段/指标名/类型/频率/单位；`POST /api/data/source/register` 登记后立即用 `collect.js source` 测试可达性；
  - 测试通过且勾选「立即启用」→ source/metric 置 active；
  - 测试失败保留 draft，方便改 URL 后重试；HTML 来源默认非结构化，不会直接建自动 job。

## 4.5 报告数据新鲜度与签发门禁（2026-11）

- `GET /api/report/freshness?case=`：从 need item 的 `dataAsOf` / `auto.quality` 汇总；
- 最终报告 manifest 增加 `dataFreshness`（items + stale）与 `dataAsOf`；
- 报告正文自动追加「数据说明」脚注：每个指标的数据截至、是否过期、证据 `[S#]`；
- 签发 `/api/report/sign`：
  - 有过期项且未确认 → 409 `code=data_stale` + `staleItems`；
  - `acceptStale:true` 必须同时给 `reason`，否则 400；
  - 接受后签名记录 `dataFreshness.accepted/reason`，账本写 `report.sign.stale_accepted`；
- 面板报告弹窗显示「数据截至」；签发遇到 409 会列出过期项并要求填写原因。

## 4.6 核心宏观多源交叉校验（2026-11）

- 只对配置了 `metric.crossCheck` 的核心指标启用（M1/M2/社融/LPR/SHIBOR/US10Y）；
- data-worker 主源成功后，按 fallback 链尝试下一个可用源，比较共同 period 的最近 N 期：
  - 差异 > `absTolerance` 或相对 `relTolerance` → `mismatch`；
  - 无共同 period → `insufficient`（不阻断）；
  - 备用源不可用 → `unavailable`（不阻断，主源单源入库但记录说明）；
- `mismatch` 时 job 仍 `extracted`，但 broker 将缺口置为 `needs_review`，不自动关闭；
- 交叉源原始文件写 `runtime/data/raw/<job>-xcheck.json`，不覆盖主源快照；
- 证据 note 与 `need.auto.crossCheck` 记录状态/来源/差异，面板显示「多源校验不一致」。

配置示例（M1）：

```json
"crossCheck": { "enabled": true, "absTolerance": 0.1, "maxPeriods": 6 }
```

## 4.7 数据源定时体检（2026-11）

- broker watchdog 每 6 小时检查 `runtime/data/source-health.json` 的 `checkedAt`；
- 超过 6 小时则后台启动 `source-doctor --refresh`，账本写 `source.health.refresh`；
- 每个来源记录 `lastOkAt / lastErrorAt / consecutiveFailures / latencyMs`；
- 面板「数据源」行显示「上次可用 HH:MM · 120ms」「连续失败 N 次」；
- 手动「重新检测」仍可用，不等待定时任务。

## 4.8 数据字典 / 口径卡（2026-11）

- `GET /api/needs` 给每个已匹配 item 附带 `metricInfo`：name/definition/unit/frequency/stockFlow/region/sourceNote/sources；
- 面板缺口弹窗显示「口径：… · 单位 … · 频率 … · 来源说明」；
- 用户确认前就知道这个数是什么口径、单位、频率，减少“数字对但口径错”。

## 5. Connector 契约

所有 connector 都是零依赖 Node 22 脚本（内置 fetch），通过 `config/sources/*.json` 的 `kind: "script"` 调用：

```json
{
  "id": "eastmoney-money-m1",
  "kind": "script",
  "runtime": "node",
  "script": "scripts/eastmoney-series.js",
  "args": ["--report", "RPT_ECONOMY_CURRENCY_SUPPLY", "--range", "{range}", "..."],
  "vars": { "range": "2025-01..2026-11" }
}
```

成功（exit 0，stdout 一行 JSON）：

```json
{"ok":true,"source":"...","range":"2025-01..2026-11","records":[{"period":"2025-01","value":0.4,"unit":"%"}]}
```

失败（exit 1，stdout + stderr 各一行）：

```json
{"ok":false,"error":"HTTP 500"}
```

要求：

- `records` 按 `period` 升序；
- `period` 为 `YYYY-MM`（月度）或 `YYYY-MM-DD`（日度）；
- 过滤空值/非数字；按 `--range` 过滤；
- **失败必须 exit 1**，否则 data-worker 不会 fallback；
- 输出不要包含指令/HTML，只输出结构化数据。

## 6. 已实现的免费 connector（2026-11 实测）

| connector | 来源 | 指标 | 实测 |
|---|---|---|---|
| `scripts/mofcom-tsf.js` | 商务部数据中心 | 社融增量 `macro.tsf` | 16 条，2025-01..2026-04（源头滞后） |
| `scripts/eastmoney-series.js` | 东方财富数据中心 | M1/M2 同比、LPR | M1 22 条；LPR 22 条 |
| `scripts/chinamoney-series.js` | 中国货币网（CFETS） | SHIBOR 1W | 463 条，2025-01..2026-11（跨年分片） |
| `scripts/fred-series.js` | FRED（免费 key） | 美国 10Y 国债 | 无 key 时明确失败；有 key 走 API |
| `scripts/eastmoney-series.js` + `RPTA_WEB_RATE` | 东方财富 | LPR 1Y | 日度，10 条/年（报价日） |

> 免费源数据可能滞后（社融最新到 2026-04、M1 到 2026-10），这是来源本身的上限，不是 connector bug；coverage 不足时缺口保持“部分完成/待人工”，不静默当完整。

## 7. 可选 provider（不作为默认依赖）

| provider | 门槛 | 用途 | 没配置时 |
|---|---|---|---|
| Tushare | token + ≥2000 积分（按接口不同） | 社融/M1M2/LPR/SHIBOR/US10Y/R007/DR007 等兜底 | 跳过，走免费源；无免费源则 `no_source` + 上传提示 |
| FRED | 免费 API key | 美国国债收益率 | 跳过，走 Tushare（如有）或上传 CSV |
| Mysteel/SMM/猫眼/灯塔/QuestMobile | 账号 | 行业/商品/票房/MAU | 默认不启用，人工上传 |

凭据位置：

- Tushare：`runtime/secrets/tushare.json`（`{"token":"..."}`，已 gitignore）或 `TUSHARE_TOKEN`；
- FRED：`runtime/secrets/fred.json`（`{"api_key":"..."}`）或 `FRED_API_KEY`。

## 8. 手工上传兜底

自动链全部不可用/失败时，缺口进入“待补数据”，用户可在缺口弹窗：

1. 上传 CSV/Excel/PDF（`POST /api/upload`，落到 `vault/<case>/uploads/`）；
2. 或填 URL / 文字说明；
3. 逐项确认口径后入库，关闭缺口。

上传路径不依赖任何 token，是开源用户的最终兜底。

## 9. 新增一个数据源的验收清单

1. 在 `config/sources/<id>.json` 写 connector 配置（`kind: script` 或 `json/html`）；
2. 在 `config/data/sources.json` 注册 `access`（tier / auth / secret / env / probe）；
3. 在 `config/data/metrics.json` 把该来源放进目标指标的 `sources` 数组（免费源放前面）；
4. 跑 `node scripts/source-doctor.js --refresh --id <id>`，确认 `available=true` 或给出明确原因；
5. 跑 `node scripts/collect.js source <id> --var range=2025-01..2026-11`，确认 `ok=true` 且 `records>0`；
6. 用临时 case 建一个 need，确认 job `extracted`、coverage、缺口自动关闭；
7. 把结果补进本文件第 6 节和 `docs/DATA-SOURCE-MATRIX.md`；
8. 如果来源有门槛，必须在 `access.note` 写清楚“缺什么/去哪申请/没配置时怎么办”。

## 10. 验收命令

```bash
node scripts/test-connectors.js       # 免费 connector 真实联网（FRED 无 key 自动 SKIP）
node scripts/test-source-chain.js     # 能力分层/链顺序/跳过原因（不联网，15 项）
node scripts/test-data-quality.js     # 质量门禁（不联网，11 项）
node scripts/test-data-crosscheck.js  # 多源交叉校验（不联网，6 项）
node scripts/test-data-pipeline.js    # 自动采集→质量门禁→S# 证据→缺口状态（需 broker）
node scripts/test-report-freshness.js # 报告 dataAsOf→签发 409→acceptStale（需 broker）
node scripts/source-doctor.js --refresh
cd dashboard && node build.js && node test.js
```

闭环验收（临时 case，完成后删除）：

- 5 个通用指标（M1/M2/社融/LPR/SHIBOR）全部由免费源自动采集，coverage 100%，need `answered/closed`；
- SHIBOR 跨年 `2025-01..2026-11` 由货币网分片返回 463 条；
- US10Y 在无 FRED key 时跳过 `fred-us10y`，链回退到可选 Tushare（有 token）或 `no_source`（无 token）；
- 模拟无 token：DR007 链为空，`item.auto.status=no_source`，reason 明确“暂无免费公开源，可上传 CSV 或配置可选积分源”。

## 11. 已知缺口（不假装已解决）

- `macro.dr007` / `rates.repo7`：目前没有找到稳定的免费公开源；中国货币网的 `FrrHis` 是 FR007/FDR007 **定盘利率**，不是 DR007/R007 加权平均，不能替代；保持“上传 CSV 或可选 Tushare”。
- `macro.credit_spread`：中债信用曲线需授权/复杂抓取，暂 `no_source`。
- `macro.special_bond`：财政部/地方债平台未结构化，保持 draft + 上传。
- FRED 成功路径未在本机实测（无 key）；有 key 后应补一次 `fred-series.js` 真实取数。
- 来源数据新鲜度差异（社融滞后）由 coverage/人工确认处理，不做静默填充。
