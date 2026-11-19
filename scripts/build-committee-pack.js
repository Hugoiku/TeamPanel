"use strict";
/** Build a pre-committee material pack: report, summary, model, scenarios, exhibits. */
const fs=require("fs"),path=require("path"),{spawnSync}=require("child_process");
const ROOT=path.resolve(__dirname,".."),CASE=process.argv[process.argv.indexOf("--case")+1]||"";
if(!CASE)process.exit(2);
const vault=path.join(ROOT,"vault",CASE),base=path.join(vault,"research"),outDir=path.join(vault,"reports","committee");
fs.rmSync(outDir,{recursive:true,force:true});fs.mkdirSync(path.join(outDir,"exhibits"),{recursive:true});
const read=(p,d)=>{try{return JSON.parse(fs.readFileSync(path.join(base,p),"utf8"));}catch(e){return d;}};
const claims=read("claims.json",{}),model=read("investment-model.json",{}),cats=read("catalysts.json",{items:[]});
fs.copyFileSync(path.join(vault,"reports","final-report.docx"),path.join(outDir,"final-report.docx"));
try{fs.copyFileSync(path.join(vault,"reports","investor-final.md"),path.join(outDir,"investor-final.md"));}catch(e){}
const d=((claims.stock||{}).valuation||{}).dcf||{};
const L=[];L.push("# 投委会前材料 · "+CASE,"");
L.push("## 速览","");L.push("- 建议："+((claims.stock&&claims.stock.rating)||"未评级"));
L.push("- 时间窗：12 个月");
if(claims.stock&&claims.stock.price)L.push("- 现价："+claims.stock.price+" 元");
L.push("- DCF 下限："+(d.per_share||"—")+" 元");
L.push("- 目标价："+(claims.stock&&claims.stock.target?JSON.stringify(claims.stock.target):"不设目标价"));
L.push("", "## 核心结论","",String(claims.thesis||""),"");
L.push("## 估值三档","");L.push("| 乐观 | 基准 | 压力 |");L.push("|---|---|---|");
const s=d.terminal_margin_sensitivity||{};L.push("| "+(s["20pct"]||"—")+" | "+(d.per_share||"—")+" | "+(s["10pct"]||"—")+" |");
L.push("", "## 关键事实","");
((claims.industry&&claims.industry.claims)||[]).concat((claims.stock&&claims.stock.claims)||[]).slice(0,5).forEach(x=>L.push("- "+String(x.text||"").slice(0,240)+((x.source)?" ["+x.source+"]":"")));
L.push("", "## 未来催化剂","");
const active=(cats.items||[]).filter(x=>x.status==="进行中"||x.status==="待发生");
active.forEach(x=>L.push("- "+x.date+" · "+x.event+" · "+(x.verified?"已核验":"待核验")+" ["+(x.sources||[]).join(" ")+"]"));
L.push("", "## 主要风险","");
[claims.macro&&claims.macro.risks].concat((claims.industry&&claims.industry.risks)||[],(claims.stock&&claims.stock.risks)||[]).filter(Boolean).slice(0,4).forEach(x=>L.push("- "+x));
fs.writeFileSync(path.join(outDir,"committee-summary.md"),L.join(String.fromCharCode(10))+"\n");
const mlines=["field,value"];
["revenue2026e","wacc","g","terminalMargin","netCash","shares","price"].forEach(k=>mlines.push(k+","+(model[k]!==undefined?model[k]:"")));
if(model.computed)mlines.push("perShare,"+model.computed.perShare);
fs.writeFileSync(path.join(outDir,"valuation-model.csv"),mlines.join(String.fromCharCode(10))+"\n");
const sl=["scenario,dcf_low,dcf_high"];
if(s.scenario_1_clearance)sl.push("clearance,"+(s.scenario_1_clearance.dcf_per_share_ref||[]).join(","));
if(s.scenario_2_status_quo)sl.push("status_quo,"+(s.scenario_2_status_quo.dcf_per_share_ref||[]).join(","));
fs.writeFileSync(path.join(outDir,"scenarios.csv"),sl.join(String.fromCharCode(10))+"\n");
let md="";try{md=fs.readFileSync(path.join(vault,"reports","investor-final.md"),"utf8");}catch(e){}
for(const m of md.matchAll(/!\[[^\]]*\]\((figures\/[^)]+)\)/g)){try{const f=path.join(vault,m[1]);if(fs.existsSync(f))fs.copyFileSync(f,path.join(outDir,"exhibits",path.basename(f)));}catch(e){}}
fs.writeFileSync(path.join(outDir,"README.txt"),"投委会前材料包\n\nfinal-report.docx  主线报告\ncommittee-summary.md  一页速览\nvaluation-model.csv  估值假设\nscenarios.csv  情景区间\nexhibits/  图表\n");
const zip=path.join(outDir,"committee-pack.zip");
const zr=spawnSync("/usr/bin/zip",["-r","committee-pack.zip","final-report.docx","committee-summary.md","valuation-model.csv","scenarios.csv","exhibits"],{cwd:outDir,encoding:"utf8",timeout:30000});
console.log(JSON.stringify({ok:zr.status===0,out:"reports/committee/committee-pack.zip",dir:"reports/committee",files:["final-report.docx","committee-summary.md","valuation-model.csv","scenarios.csv","exhibits/"]}));
