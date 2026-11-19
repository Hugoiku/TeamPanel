"use strict";
/** Safe tone cleanup before Word assembly: strip inline scaffold labels, de-semicolon prose. */
const fs = require("fs");
const path = require("path");
function arg(k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; }
const src = arg("md", ""), dst = arg("out", "");
if (!src || !dst) { console.error("--md --out required"); process.exit(2); }
let text = fs.readFileSync(src, "utf8");
const lines = text.split(String.fromCharCode(10));
const out = [];
let removedMeta = 0, removedLabels = 0, semicolons = 0;
for (const line of lines) {
  if (/^- (装配来源|证据池|说明：本报告仅覆盖)/.test(line)) { removedMeta += 1; continue; }
  let ln = line;
  if (!ln.trimStart().startsWith("|")) {
    const before = ln;
    ln = ln.replace(/\*\*([^*\n]{1,24})\*\*：/g, (m) => { removedLabels += 1; return ""; });
    if (ln !== before) {}
  }
  if (!ln.trimStart().startsWith("|") && !ln.trimStart().startsWith("#") && ln.indexOf("；") >= 0) {
    semicolons += (ln.match(/；/g) || []).length;
    ln = ln.replace(/；/g, "，");
  }
  out.push(ln);
}
let clean = out.join(String.fromCharCode(10));
clean = clean.replace(/\n{3,}/g, String.fromCharCode(10) + String.fromCharCode(10));
fs.mkdirSync(path.dirname(path.resolve(dst)), { recursive: true });
fs.writeFileSync(dst, clean);
console.log(JSON.stringify({ ok: true, out: dst, chars: clean.length, removedMeta, removedLabels, semicolons }));
