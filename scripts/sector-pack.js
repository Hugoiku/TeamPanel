"use strict";
const fs=require("fs"),path=require("path");
const ROOT=path.resolve(__dirname,".."),CASE=process.argv[process.argv.indexOf("--case")+1]||"";
if(!CASE)process.exit(2);
const vault=path.join(ROOT,"vault",CASE);
let text="";["mission.md","research/macro.md","research/industry.md","research/stock.md"].forEach(f=>{try{text+="\n"+fs.readFileSync(path.join(vault,f),"utf8");}catch(e){}});
const dir=path.join(ROOT,"config/sector-packs");
let best={id:"default",score:0,pack:null};
fs.readdirSync(dir).filter(f=>f.endsWith(".json")).forEach(f=>{try{const j=JSON.parse(fs.readFileSync(path.join(dir,f),"utf8"));const score=(j.keywords||[]).filter(k=>text.indexOf(k)>=0).length;if(score>best.score)best={id:f.replace(/\.json$/,""),score,pack:j};}catch(e){}});
if(!best.pack){best={id:"default",score:0,pack:JSON.parse(fs.readFileSync(path.join(dir,"default.json"),"utf8"))};}
let tushareL1 = best.pack.tushareL1 || [], tushareL2 = best.pack.tushareL2 || [], tushareL3 = best.pack.tushareL3 || [];
let tushareIndustry = [];
try { const tree = JSON.parse(fs.readFileSync(path.join(ROOT,"runtime/cache/tushare/index-classify-SW2021-L1.json"),"utf8")); const names = new Set(tushareL1); tushareIndustry = (tree.rows||[]).filter(x=>names.has(x.industry_name)).map(x=>({code:x.index_code,name:x.industry_name,level:x.level})); } catch(e) {}
const out={id:best.id,label:best.pack.label,kpis:best.pack.kpis,valuationMethods:best.pack.valuationMethods,reportSections:best.pack.reportSections,sourceHints:best.pack.sourceHints,reviewChecks:best.pack.reviewChecks,tushareL1,tushareL2,tushareL3,tushareIndustry,detectedBy:best.score?"keywords":"default",generatedAt:new Date().toISOString()};
fs.mkdirSync(path.join(vault,"research"),{recursive:true});fs.writeFileSync(path.join(vault,"research","sector-pack.json"),JSON.stringify(out,null,2));
console.log(JSON.stringify({ok:true,sectorPack:out}));
