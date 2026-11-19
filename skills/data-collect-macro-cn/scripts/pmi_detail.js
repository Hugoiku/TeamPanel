#!/usr/bin/env node
"use strict";
// pmi_detail — Tushare PMI 分项（制造业/非制造业）
const https = require("https"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
function token() { return JSON.parse(fs.readFileSync(path.join(ROOT, "runtime/secrets/tushare.json"), "utf8")).token; }
function post(body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const r = https.request({ hostname: "api.tushare.pro", path: "/", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, x => {
      let s = ""; x.on("data", d => s += d); x.on("end", () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } });
    });
    r.on("error", rej); r.write(data); r.end();
  });
}
const LABELS = {
  pmi010000: "制造业PMI", pmi010100: "生产", pmi010200: "新订单", pmi010300: "原材料库存",
  pmi010400: "从业人员", pmi010500: "供应商配送时间", pmi010600: "新出口订单",
  pmi010700: "积压订单", pmi010800: "产成品库存", pmi010900: "采购量",
  pmi011000: "进口", pmi011100: "购进价格", pmi011200: "出厂价格",
  pmi020100: "非制造业商务活动", pmi020200: "新订单", pmi020300: "投入品价格",
  pmi020400: "销售价格", pmi020500: "从业人员", pmi020600: "业务活动预期"
};
(async () => {
  const months = parseInt(arg("months", "12"), 10) || 12;
  const end = new Date(), start = new Date(Date.now() - months * 31 * 86400000);
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, "");
  const j = await post({ api_name: "cn_pmi", token: token(), params: { start_date: fmt(start), end_date: fmt(end) }, fields: "" });
  if (j.code !== 0) { console.log(JSON.stringify({ ok: false, error: j.msg, code: j.code })); process.exit(3); }
  const fields = (j.data && j.data.fields) || [], items = (j.data && j.data.items) || [];
  const latest = items[0] || [];
  const values = {};
  fields.forEach((f, i) => { values[f] = latest[i]; });
  const labeled = {};
  Object.keys(LABELS).forEach(f => { if (values[f] != null) labeled[LABELS[f]] = values[f]; });
  console.log(JSON.stringify({ ok: true, source: "tushare", api: "cn_pmi", month: latest[0],
    fields, values, labeled, note: "字段映射按 Tushare cn_pmi 常用字段；如口径有变化请核对 fields。" }, null, 2));
})().catch(e => { console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) })); process.exit(1); });
