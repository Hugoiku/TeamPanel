# 通用数据源矩阵（2026-11，免费优先）

原则：

1. 核心 connector 只做通用型数据源，不绑定行业。
2. **免费公开源优先**：开源用户没有 Tushare 积分也必须能跑通主流程。
3. 积分/账号源只作为**可选 provider**，放在 `metric.sources` 末尾；不可用时跳过并说明原因。
4. 行业数据（SEMI、ASML IR、海关 HS、公司公告等）属于 domain pack，由领域包声明优先用哪些通用指标/来源，不新增核心 connector。
5. 每个 metric 必须有：来源、字段、单位、频率、coverage、raw snapshot、evidence。
6. 没有结构化 connector 的 metric 不建自动 job，直接 `no_source` 或 draft，并提示上传 CSV。
7. 口径/单位/频率/stockFlow 用确定性门禁；语义判断交给模型，但不能替代可验证约束。

## 1. 免费 connector（默认路径，已实测）

| 数据 | metric | 免费来源 | connector | 状态/实测 |
|---|---|---|---|---|
| 社融增量 | `macro.tsf` | 商务部数据中心 | `scripts/mofcom-tsf.js` | ✅ 16 条，2025-01..2026-04（源头滞后） |
| M1 同比 | `macro.m1_yoy` | 东方财富数据中心 | `scripts/eastmoney-series.js` | ✅ 22 条，2025-01..2026-10 |
| M2 同比 | `macro.m2_yoy` | 东方财富数据中心 | `scripts/eastmoney-series.js` | ✅ 22 条 |
| 1 年期 LPR | `rates.lpr_1y` | 东方财富数据中心 | `scripts/eastmoney-series.js` | ✅ 22 条（报价日） |
| SHIBOR 1W | `rates.shibor_1w` | 中国货币网（CFETS） | `scripts/chinamoney-series.js` | ✅ 463 条，2025-01..2026-11（跨年分片） |
| 美国 10Y 国债 | `rates.us10y` | FRED（免费 key） | `scripts/fred-series.js` | ⚠️ 无 key 时明确失败；有 key 走 API |
| CPI/PPI/PMI/GDP | `macro.*` | 东方财富 | `eastmoney-*` JSON 源 | ✅ 已有 |
| 10Y 国债（当前曲线） | `macro.cn10y` | 中债 | `scripts/chinabond.py` | ✅ 当前值；历史区间待补 |

## 2. 可选积分源（Tushare，不默认依赖）

| 数据 | metric | Tushare 接口 | 状态 |
|---|---|---|---|
| 社融增量 | `macro.tsf` | `sf_month` | 可选兜底 |
| M1/M2 | `macro.m1_yoy` / `m2_yoy` | `cn_m` | 可选兜底 |
| LPR | `rates.lpr_1y` | `shibor_lpr` | 可选兜底 |
| SHIBOR | `rates.shibor_1w` | `shibor` | 可选兜底 |
| 美国 10Y | `rates.us10y` | `us_tycr` | 可选兜底 |
| R007 | `rates.repo7` | `repo_daily`（R007） | 可选；无免费源 |
| DR007 | `macro.dr007` | `repo_daily`（DR007.IB） | 可选；无免费源 |
| 国债曲线 | `rates.gov_curve` | `yc_cb` 无权限 | 未接 |
| 信用利差 | `macro.credit_spread` | 无直接接口 | `no_source`，待中债曲线 |

Tushare 凭据：`runtime/secrets/tushare.json` 或 `TUSHARE_TOKEN`；积分不足时 `source-health` 探测到 `40203` 会标记不可用，链自动跳过。

## 3. 无免费源 / 待接（明确降级）

| 数据 | metric | 现状 | 兜底 |
|---|---|---|---|
| DR007 | `macro.dr007` | 无稳定免费源；FDR007 是定盘利率，不能替代 | 上传 CSV；或配置可选 Tushare |
| R007 | `rates.repo7` | 无稳定免费源 | 上传 CSV；或配置可选 Tushare |
| 信用利差 | `macro.credit_spread` | 中债信用曲线需授权/复杂抓取 | 上传 CSV / 登记来源 |
| 专项债发行进度 | `macro.special_bond` | 财政部/地方债平台未结构化 | 上传 CSV；保持 draft |
| 财政收支 | `fiscal.revenue_expense` | 财政部页面非结构化 | 上传 CSV / 后续专用 connector |
| USD/CNY | `fx.usdcny` | Tushare `fx_daily` 需选 ts_code；免费源待接 | 上传 CSV / 可选 Tushare |
| 商品期货 | `commodity.*` | Tushare `fut_daily` 需选合约；免费源待接 | domain pack / 上传 |
| 分红/回购/股东结构 | `equity.*` | Tushare 接口需积分 | 可选 Tushare / 上传 |
| 政策/公告/专利/招投标 | — | 非结构化 | 通用抓取 + 人工/模型抽取 |

## 4. 能力分层与健康检测

- `access.tier`：`free / free-key / token / credit / account`；
- `scripts/source-health.js`：静态凭据检查 + 联网 probe + 6h 缓存；
- `scripts/source-doctor.js --refresh`：体检 CLI；
- `GET /api/data/source-health`：面板右栏「数据源」展示；
- 链顺序：`metric.sources` 数组顺序（免费在前），不可用源跳过并记录原因；
- 失败换源写账本 `data.job.fallback`；重试耗尽转人工上传。

详细规范见 [CONNECTOR-SPEC.md](./CONNECTOR-SPEC.md)。

## 5. 实施顺序（更新）

1. ✅ 免费宏观/利率 connector：社融、M1/M2、LPR、SHIBOR；
2. ✅ 能力分层 + 健康检测 + fallback 链 + 面板状态；
3. ⏳ FRED key 成功路径实测；USD/CNY、商品期货免费源；
4. ⏳ 中债信用利差、专项债、财政收支；
5. ⏳ 权益扩展（分红/回购/股东结构）；
6. 行业数据继续留在 domain pack，不进核心 connector。

> 注：Tushare 接口“可用”只代表能取到数据；本仓库默认不依赖它。没有积分时，免费源 + 上传 CSV 仍可完成研究闭环。
