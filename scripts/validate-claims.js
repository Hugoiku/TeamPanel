"use strict";
const fs=require("fs"),path=require("path");
const ROOT=path.resolve(__dirname,".."),CASE=process.argv[process.argv.indexOf("--case")+1]||"";
if(!CASE)process.exit(2);
const base=path.join(ROOT,"vault",CASE,"research");
const claims=JSON.parse(fs.readFileSync(path.join(base,"claims.json"),"utf8"));
const ids=new Set();
try{for(const l of fs.readFileSync(path.join(ROOT,"vault",CASE,"evidence","sources.jsonl"),"utf8").split(/\r?\n/)){if(!l.trim())continue;try{const e=JSON.parse(l);if(e.id)ids.add(String(e.id));}catch(e){}}}catch(e){}
const issues=[];
const all=[...(claims.macro.claims||[]),...(claims.industry.claims||[]),...(claims.stock.claims||[])];
all.forEach(c=>{
  const refs=[...(String(c.source||"").match(/S\d+/g)||[]),...(String(c.text||"").match(/S\d+/g)||[])];
  const kind = c.kind || (/2026E|2027E|预计|预测|测算/.test(String(c.text||"")) ? "forecast" : "fact");
  if(!refs.length)issues.push({level:kind==="fact"?"high":"medium",id:c.id,message:"claim 无证据引用（"+kind+"）"});
  refs.forEach(r=>{if(!ids.has(r))issues.push({level:"high",id:c.id,message:"引用不存在 "+r});});
  if(kind==="forecast" && !/2026E|2027E|预测|测算|机构/.test(String(c.text||""))) issues.push({level:"medium",id:c.id,message:"forecast 未标预测"});
});
if(!claims.thesis)issues.push({level:"high",id:"thesis",message:"缺投资论点"});
const high=issues.filter(x=>x.level==="high").length;
const kinds={};all.forEach(c=>{const k=c.kind||(/2026E|2027E|预计|预测|测算/.test(String(c.text||""))?"forecast":"fact");kinds[k]=(kinds[k]||0)+1;});
const out={ok:high===0,case:CASE,claims:all.length,high,kinds,issues,generatedAt:new Date().toISOString()};
fs.writeFileSync(path.join(base,"claims-validation.json"),JSON.stringify(out,null,2));
console.log(JSON.stringify(out));
