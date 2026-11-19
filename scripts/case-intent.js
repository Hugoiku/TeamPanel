"use strict";
/**
 * case-intent — 把用户一句话解析成 case 的标的/类型/任务。
 * 规则优先，零 token；解析不确定时返回 ambiguous + options，由面板再确认。
 */
function parse(text) {
  const raw = String(text || "").trim();
  const out = { text: raw, ticker: "", kind: "", mandate: raw, name: "",
    confidence: 0.35, ambiguous: true, options: ["个股", "行业", "ETF", "指数", "宏观", "其他"] };
  if (!raw) return out;
  let ticker = "", kind = "";
  const clean = raw.replace(/^(请|帮我|我想|想|评估|分析|研究|看看|看|关注|投资|买入|增持)\s*/, "");
  const code = (raw.match(/(?:^|[^0-9])(\d{6})(?:[^0-9]|$)/) || [])[1] || "";
  if (/ETF/i.test(raw)) kind = "ETF";
  else if (/指数/.test(raw)) kind = "指数";
  else if (/行业|板块|产业链/.test(raw)) kind = "行业";
  else if (/个股|公司|股票|估值|目标价|买入|增持/.test(raw)) kind = "个股";
  else if (/宏观|利率|汇率|货币政策|财政政策/.test(raw)) kind = "宏观";
  if (code) {
    const after = raw.slice(raw.indexOf(code) + 6).match(/^[\s：:，,、-]*([\u4e00-\u9fa5A-Za-z0-9]{2,12})/);
    ticker = code + (after ? " " + after[1] : "");
    if (!kind) kind = "个股";
  }
  if (!ticker) {
    const etf = raw.match(/([\u4e00-\u9fa5A-Za-z0-9]{2,16}ETF)/i);
    if (etf) { ticker = etf[1]; kind = "ETF"; }
  }
  if (!ticker) {
    const entity = clean.match(/([\u4e00-\u9fa5A-Za-z0-9]{2,16}(?:银行|证券|保险|集团|股份|科技|药业|能源|汽车|电器|电子|材料|矿业|地产|食品|酒业|传媒|影视|网络|软件|医药|航空|港口|电力|环保|化工|钢铁|有色|水泥|家电|机械|通信|半导体|新能源))/);
    if (entity) { ticker = entity[1]; if (!kind) kind = "个股"; }
  }
  if (!ticker) {
    const industry = clean.match(/([\u4e00-\u9fa5A-Za-z0-9]{2,16})(?:行业|板块|产业链)/);
    if (industry) { ticker = industry[1]; kind = "行业"; }
  }
  if (!ticker && /宏观/.test(raw)) { ticker = "宏观"; kind = "宏观"; }
  if (ticker) out.ticker = ticker;
  if (kind) out.kind = kind;
  out.name = (ticker || raw.slice(0, 20)).replace(/[\\/:*?"<>|]/g, "").slice(0, 40) || ("研究-" + new Date().toISOString().slice(0, 10));
  out.confidence = ticker && kind ? 0.85 : (ticker || kind ? 0.6 : 0.35);
  out.ambiguous = !(ticker && kind);
  if (out.ambiguous) out.options = [kind || "个股", "行业", "ETF", "指数", "宏观", "其他"].filter((x, i, a) => a.indexOf(x) === i);
  return out;
}
module.exports = { parse };
if (require.main === module) {
  const i = process.argv.indexOf("--text");
  const text = i >= 0 ? process.argv.slice(i + 1).join(" ") : process.argv.slice(2).join(" ");
  console.log(JSON.stringify(parse(text), null, 2));
}
