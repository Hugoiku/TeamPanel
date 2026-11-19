# 从网址识别数据（Web Data Intake）

> 目标：用户只给一个网址，模型能自己找到统计页、详情页和附件，优先拿结构化数据；只有图片时才 OCR。

## 1. 一条命令抓一个站点

~~~bash
node scripts/collect.js site '<起始 URL>' --out runtime/cache/collect/my-site --depth 1 --max-pages 8
~~~

输出：

~~~text
runtime/cache/collect/my-site/
  bundle.json          # 页面 + 附件索引
  pages/p01.md ...     # 渲染后的页面文本/链接
  attachments/a01.csv  # 自动下载并转成 CSV 的 XLS/XLSX/CSV
  attachments/a02.md   # 自动提取的 PDF 文本
~~~

抓取规则：

- 用浏览器渲染，能拿到 JS 页面和 XHR 后的内容；
- 只跟同域链接；
- 优先跟「统计信息 / 总资产 / 总负债 / 月度 / 季度 / 经营情况表 / 历史数据 / 数据表」等页面；
- 遇到 .xls / .xlsx / .csv / .pdf 直接下载并提取；
- bundle.json 是给模型看的入口，先读它，再按需读 pages/* 和 attachments/*。

## 2. 通用网页解析 Agent（推荐）

如果页面结构不固定、需要点 tab/跟链接/找附件，用 `web_agent.py`：

~~~bash
PYTHONPATH=runtime/py python3 scripts/web_agent.py \
  --url '<URL>' \
  --goal '统计信息里的银行业金融机构总资产、总负债月度数据（2026年1-9月）' \
  --max-steps 8 \
  --out runtime/cache/collect/web-agent.json
~~~

模型会自主调用工具：

- `open`：打开 snapshot 里的链接
- `snapshot`：看页面文本、链接、按钮、表格、附件
- `click`：点 tab/按钮/链接
- `network`：读 XHR/JSON
- `extract`：自动下载当前页的 XLS/PDF 附件并解析
- `download`：下载指定附件
- `ocr`：图片兜底

输出：

~~~json
{
  "ok": true,
  "result": {
    "records": [
      { "name": "银行业金融机构总资产", "value": 4806061.69, "period": "2026年1月",
        "unit": "亿元", "sourceUrl": "https://...xls", "confidence": 1 }
    ],
    "notes": "...",
    "needsReview": false
  },
  "trace": [ ... ]
}
~~~

Tool Gateway 也暴露了 `web.agent`：

~~~text
web.agent({ url, goal, maxSteps }) -> { records, notes, trace }
~~~

这样员工/Lead 可以在对话中直接给 URL 和目标板块，由模型自己决定怎么点、怎么找附件，而不是走固定模板。

### 多页列表

列表页有分页时，Agent 会优先调用 `paginate`：

- 自动找「下一页 / 下页 / Next」并点击
- 收集详情页链接和附件链接
- 用 `filter` 限定目标，例如 NFRA 统计信息列表用 `itemId=954`
- 用 `--max-pages` 或目标日期范围控制停止

示例：

~~~bash
PYTHONPATH=runtime/py python3 scripts/web_agent.py \
  --url 'https://www.nfra.gov.cn/cn/view/pages/ItemList.html?itemPId=953&itemId=954&itemUrl=ItemListRightList.html&itemName=统计信息' \
  --goal '统计信息列表：银行业金融机构总资产、总负债月度数据，2026年1-9月' \
  --max-pages 3 --max-steps 12
~~~

模型会调用：

~~~text
paginate({ maxPages: 3, filter: "itemId=954" })
  → 返回详情页列表
  → open 每个详情页
  → extract 下载 XLS
~~~

注意：

- 优先找分页 XHR/API（pageNum/pageSize），比点下一页快；
- 去重按 docId/URL；
- 目标日期范围满足后停止，不要盲目抓完 77 页；
- 大量详情页要限制并发，避免给站点造成压力。

### NFRA 实测

~~~bash
PYTHONPATH=runtime/py python3 scripts/web_agent.py \
  --url 'https://www.nfra.gov.cn/cn/view/pages/tongjishuju/tongjishuju.html' \
  --goal '统计信息板块里的银行业金融机构总资产、总负债月度历史数据（2026年1-9月）' \
  --max-steps 10
~~~

实测可以自动进入「统计信息」列表、打开详情页、下载 XLS，并输出总资产/总负债的月度记录（单位亿元、含同比增速），不需要 OCR。

## 3. 模型怎么用

给员工/Lead 的提示词可以写：

~~~text
先用 node scripts/collect.js site <URL> 抓取站点；
读 bundle.json，找到统计信息/月度/季度数据页和附件；
优先读 attachments/*.csv，不要先 OCR；
把候选指标、单位、频率、时间范围、来源 URL 列出来；
只有没有 XLS/PDF/JSON 时，才对图片执行 ocr，并标记 needs_review。
~~~

## 3.1 多轮对话与结果确认

### 多轮对话

`web_agent.py` 单次运行是“给 URL + 目标，自主跑完”。多轮修正通过：

~~~bash
PYTHONPATH=runtime/py python3 scripts/web_agent.py \
  --url '<URL>' \
  --goal '银行业总资产、总负债月度数据' \
  --feedback '不是第一个表，要「2026年银行业金融机构总资产、总负债（月度）」这个附件' \
  --previous runtime/cache/collect/web-agent.json \
  --max-steps 8
~~~

- `--feedback`：用户对上一轮结果的纠正
- `--previous`：上一轮 JSON，模型会参考其中的 records/notes
- 员工/Lead 可以在对话中反复调用 `web.agent`，把用户反馈作为 `feedback` 传入

当前浏览器会话不跨进程持久化；多轮是在“对话层”重跑，不是同一个浏览器 tab 原地暂停/恢复。

### 结果确认

每次输出都有：

~~~json
{
  "status": "ready | needs_confirmation",
  "verification": {
    "total": 18,
    "missingFields": [],
    "lowConfidence": [],
    "needsHumanConfirm": false
  },
  "result": { "records": [ ... ], "notes": "..." }
}
~~~

确定性检查：

- 每条 record 必须有 name / value / period / unit / sourceUrl
- confidence < 0.8 标 lowConfidence
- 模型自报 needsReview 也标 needs_confirmation
- 缺少字段或低置信 → `needs_confirmation`

确认流程：

~~~text
web.agent 返回 records
  → 用户在对话里看预览
  → 接受 / 修正 / 重新解析
  → 接受后才登记 metric / evidence
  → 再进质量门禁和交叉校验
~~~

注意：`status=ready` 只代表字段完整，不代表人工已批准；写入证据前仍需要一次人工确认。

## 3.2 从面板启动（N325 这类缺口）

缺口弹窗的主按钮现在是 **「用模型补齐」**：打开 DataTask 表单，选缺口项、填 URL/文件、设预算，点“创建并开始”。模型在来源策略内解析，逐项门禁通过后由用户确认写入。详见 [DATA-TASK.md](DATA-TASK.md)。

旧的手动对话方式仍可用：弹窗里的「在对话框开始补齐」会关闭弹窗、自动选中该缺口的提出员工（如行业研究员），并把缺口各项要求预填到中栏输入框。确认/修改后回车发送即可。

也可以手动：

1. 左栏点提出缺口的员工（N325 是「行业研究员」），不要停在「all」；
2. 中栏输入框以 **`研究行业：` / `研究个股：`** 开头，避免被数据补充路由截成 intake；
3. 发送后右栏「待批计划」→「批准并执行」，员工进入 Employee Loop，可调用 `web.agent`；
4. 模型返回 `records + verification` 后先预览，不要直接写 evidence；确认后再走来源包候选/上传文件入库。

示例：

~~~text
研究行业：N325 缺招行H股前复权价格、分红序列与官方HKD/CNY中间价
目标：
1) 03968.HK 日频前复权收盘价（date, close_adj_hkd）
2) 2021-2025 每股现金分红、除净日、派息日（year, ex_date, dps, currency）
3) 中国外汇交易中心 HKD/CNY 官方中间价（date, hkd_cny_mid）
4) 港股通红利税税率与扣缴规则（文本）
执行：用 web.agent 自主浏览来源页；多页用 paginate；返回 records（name/value/period/unit/sourceUrl/confidence）+ verification。先预览，不写 evidence。
~~~

> 说明：以「研究行业/研究个股/研究公司/分析行业/分析个股：」开头会强制进入规划；其他「补充数据/抓取/解析」类说法仍走 need 级 intake 子请求。

## 4. NFRA 例子（固定模板兜底）

起始页：

~~~text
https://www.nfra.gov.cn/cn/view/pages/tongjishuju/tongjishuju.html
~~~

该页的「统计信息」详情页里，银行业总资产/总负债等是 .xls 附件，不是必须 OCR 的图片。执行：

~~~bash
node scripts/collect.js site 'https://www.nfra.gov.cn/cn/view/pages/tongjishuju/tongjishuju.html' --out runtime/cache/collect/nfra --depth 1 --max-pages 8
~~~

会得到类似：

~~~text
attachments/a01.csv  # 2026年银行业金融机构总资产、总负债（月度）.xls -> CSV
attachments/a02.csv  # 2026年9月人身险公司经营情况表.xls -> CSV
attachments/a03.csv  # 2026年9月财产险公司经营情况表.xls -> CSV
~~~

这些 CSV 可以直接映射成指标、登记证据，不需要图像识别。

## 5. 图片/图表 OCR

只有确实没有表格、附件或 JSON 时：

~~~bash
node scripts/collect.js ocr <图片或PDF> --out runtime/cache/collect/ocr.md
~~~

注意：

- 图表 OCR 精度有限，数字容易错位；OCR 结果必须标 needs_review；
- 不要把 OCR 结果直接当权威数据写进报告；
- 优先找原始 XLS/PDF/JSON 或页面背后的 XHR 接口。

## 6. 需要点击 tab 的页面

collect.js site 跟链接，不模拟点击 tab。若数据只在点击后加载：

~~~bash
node scripts/collect.js api '<URL>' --out runtime/cache/collect/api-site --wait 6000
~~~

api 会捕获 XHR/JSON 响应到 runtime/cache/collect/api-site/xhr-*.json 和 index.json。
如果必须点击，下一步可给 browser_api.py 加 --click 参数；当前先优先找页面里的 XHR 接口。

## 7. 和缺口流程的关系

推荐顺序：

~~~text
need / 用户给 URL
  → collect.js site 抓页面 + 附件
  → 模型识别指标/单位/频率/时间范围
  → 建 draft / 语义匹配（必要时）
  → 登记 source + evidence
  → 质量门禁 / 交叉校验
~~~

图片 OCR 是最后兜底，不是主路径。
