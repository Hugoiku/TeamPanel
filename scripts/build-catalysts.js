"use strict";
/** Build a source-backed catalyst calendar from structured research JSON. */
const fs=require("fs"),path=require("path");
const ROOT=path.resolve(__dirname,".."),CASE=process.argv[process.argv.indexOf("--case")+1]||"";
if(!CASE)process.exit(2);
const base=path.join(ROOT,"vault",CASE,"research");
const read=p=>{try{return JSON.parse(fs.readFileSync(path.join(base,p),"utf8"));}catch(e){return {};}};
const ind=read("industry.json"),stock=read("stock.json");
const ev={};
try { for(const l of fs.readFileSync(path.join(ROOT,"vault",CASE,"evidence","sources.jsonl"),"utf8").split(String.fromCharCode(10))){if(!l.trim())continue;try{const x=JSON.parse(l);if(x.id)ev[x.id]=JSON.stringify(x.value!=null?x.value:(x.text||""));}catch(e){}}}catch(e){}
function dateVerified(item){
  const text=(item.sources||[]).map(id=>ev[id]||"").join(" ");
  const dates=String(item.date||"").match(/\d{4}-\d{2}-\d{2}/g)||[];
  if(!dates.length){ item.verifyNote="无明确日期"; return false; }
  const found=dates.filter(d=>text.includes(d));
  item.verifyNote=found.length===dates.length?"日期与证据一致":("已找到 "+found.join(",")+"；缺 "+dates.filter(d=>!found.includes(d)).join(","));
  return found.length>0; // 窗口起点可核验即可，不把“12月底”误判为无来源
}
function classify(item){
  const ds=String(item.date||"").match(/\d{4}-\d{2}-\d{2}/g)||[];
  if(!ds.length) return "判断";
  const now="2026-11-15";
  const start=ds[0], end=ds.length>1?ds[1]:ds[0];
  if(end<now) return "已发生";
  if(start>now) return "待发生";
  return "进行中";
}
const items=[];
((ind.policy||{}).framework||[]).forEach(x=>{
  const when=x.window||x.effective||x.date||x.status||"";
  if(!when)return;
  const item={ date:when, event:x.doc||x.layer, type:"policy", sources:x.evidence||[], note:x.key_points&&x.key_points[0]||"", basis:"evidence" };
  item.verified=dateVerified(item); item.status=classify(item); items.push(item);
});
const ss=(stock.valuation||{}).scenario_sensitivity||{};
if(ss.scenario_1_clearance&&ss.scenario_1_clearance.rating_trigger)items.push({date:"2027H1",event:"评级上调触发",type:"rating",sources:["S19","S29","S57"],note:ss.scenario_1_clearance.rating_trigger,basis:"derived",verified:false,status:"判断"});
if(ss.scenario_2_status_quo&&ss.scenario_2_status_quo.rating_trigger)items.push({date:"2027H1",event:"评级下调触发",type:"rating",sources:["S19","S29","S57"],note:ss.scenario_2_status_quo.rating_trigger,basis:"derived",verified:false,status:"判断"});
(ind.key_variables||[]).slice(0,4).forEach(x=>items.push({date:"月度/季度",event:x.name,type:"monitor",sources:x.evidence||[],note:x.monitor||"",basis:"derived",verified:false,status:"判断"}));
const rank={ "进行中":0,"待发生":1,"已发生":2,"判断":3 };
items.sort((a,b)=>(rank[a.status]??9)-(rank[b.status]??9));
const out={ok:true,case:CASE,items,counts:{active:items.filter(x=>x.status==="进行中").length,upcoming:items.filter(x=>x.status==="待发生").length,past:items.filter(x=>x.status==="已发生").length,derived:items.filter(x=>x.status==="判断").length},generatedAt:new Date().toISOString()};
fs.writeFileSync(path.join(base,"catalysts.json"),JSON.stringify(out,null,2));
console.log(JSON.stringify({ok:true,items:items.length}));
