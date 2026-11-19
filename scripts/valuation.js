"use strict";
/** Compute the selected valuation method plus secondary cross-checks. */
const fs=require("fs"),path=require("path");
const ROOT=path.resolve(__dirname,".."),CASE=process.argv[process.argv.indexOf("--case")+1]||"";
if(!CASE)process.exit(2);
const base=path.join(ROOT,"vault",CASE,"research");
const read=(p,d)=>{try{return JSON.parse(fs.readFileSync(path.join(base,p),"utf8"));}catch(e){return d;}};
const cfg=read("valuation.json",{method:"",inputs:{},inputMeta:{}});
const model=read("investment-model.json",{}),stock=read("stock.json",{});
const num=x=>Number(x)||0;
function input(method,key){const all=cfg.inputs||{};if(all[method]&&typeof all[method]==="object")return all[method][key];return all[key];}
function shares(){return num(input("shares","shares"))||num(model.shares);}
function compute(method){
  const sh=shares();
  if(method==="dcf"){
    if(!model.computed||model.computed.perShare==null)return {status:"not_started",method,missing:[]};
    return {status:"ok",method,perShare:model.computed.perShare,ev:model.computed.ev,equity:model.computed.equity};
  }
  if(method==="comps"||method==="ev_sales"){
    const metric=num(input(method,"metricValue")||input(method,"revenue"));
    const peers=Array.isArray(input(method,"peers"))?input(method,"peers"):[];
    const peerVals=peers.map(x=>num(x.multiple)).filter(Boolean).sort((a,b)=>a-b);
    const median=peerVals.length?(peerVals[Math.floor((peerVals.length-1)/2)]+peerVals[Math.ceil((peerVals.length-1)/2)])/2:0;
    const multiple=num(input(method,"peerMultiple")||input(method,"multiple"))||median;
    const netCash=num(input(method,"netCash")||model.netCash);
    const low=num(input(method,"multipleLow")), high=num(input(method,"multipleHigh"));
    const missing=[];if(!metric)missing.push("metricValue/revenue");if(!multiple)missing.push("peerMultiple/multiple");if(!sh)missing.push("shares");
    if(missing.length)return {status:"missing",method,missing};
    const equity=metric*multiple+netCash;
    const out={status:"ok",method,metric,multiple,netCash,shares:sh,equity,perShare:Math.round(equity/sh*10)/10};
    if(peers.length)out.peers=peers.map(x=>({name:x.name||"",multiple:num(x.multiple)}));
    if(low&&high)out.range=[Math.round((metric*low+netCash)/sh*10)/10,Math.round((metric*high+netCash)/sh*10)/10];
    return out;
  }
  if(method==="nav"){
    const assets=num(input(method,"assets")),liab=num(input(method,"liabilities"));
    const missing=[];if(!assets)missing.push("assets");if(!sh)missing.push("shares");
    if(missing.length)return {status:"missing",method,missing};
    return {status:"ok",method,assets,liabilities:liab,equity:assets-liab,shares:sh,perShare:Math.round((assets-liab)/sh*10)/10};
  }
  if(method==="ddm"){
    const div=num(input(method,"dividend")),r=num(input(method,"requiredReturn"));
    const missing=[];if(!div)missing.push("dividend");if(!r)missing.push("requiredReturn");
    if(missing.length)return {status:"missing",method,missing};
    return {status:"ok",method,dividend:div,requiredReturn:r,perShare:Math.round(div/r*10)/10};
  }
  if(method==="sotp"){
    const segs=Array.isArray(input(method,"segments"))?input(method,"segments"):[];
    const netDebt=num(input(method,"netDebt"));
    const missing=[];if(!segs.length)missing.push("segments");if(!sh)missing.push("shares");
    if(missing.length)return {status:"missing",method,missing};
    const eq=segs.reduce((a,s)=>a+num(s.value),0)-netDebt;
    return {status:"ok",method,segments:segs,netDebt,equity:eq,shares:sh,perShare:Math.round(eq/sh*10)/10};
  }
  return {status:"missing",method,missing:["unknown method"]};
}
const primary=cfg.method||"";
const methods=[primary];
const results={};methods.forEach(m=>{results[m]=m?compute(m):{status:"unselected",method:"",missing:[]};});
const inputWarnings=[], inputErrors=[];
try{const now=Date.now();Object.keys(cfg.inputMeta||{}).forEach(k=>{const m=cfg.inputMeta[k]||{};if(m.asOf){const t=new Date(m.asOf+"T00:00:00").getTime();if(t>now)inputErrors.push(k+" 数据日期在未来（"+m.asOf+"）");else if(now-t>180*86400000)inputWarnings.push(k+" 数据日期超过 180 天（"+m.asOf+"）");}if(!m.source)inputWarnings.push(k+" 缺少来源");});}catch(e){}
try{const mf=JSON.parse(fs.readFileSync(path.join(ROOT,"config/valuation-methods",(cfg.method||"dcf")+".json"),"utf8"));(mf.fields||[]).forEach(f=>{const v=cfg.inputs?cfg.inputs[f.key]:undefined;if(v===undefined||v===""||v===null)return;if(f.type==="number"){if(isNaN(Number(v))||Number(v)<0)inputErrors.push(f.label+" 必须为非负数");}if(f.type==="percent"){const n=Number(v);if(isNaN(n)||n<0||n>1)inputErrors.push(f.label+" 必须在 0–1 之间");}});}catch(e){}
if(inputErrors.length)results[primary]={status:"invalid",method:primary,missing:[],errors:inputErrors};
const out=Object.assign({},cfg,{case:CASE,method:primary,result:results[primary],results,inputMeta:cfg.inputMeta||{},inputWarnings,inputErrors,targetAllowed:results[primary]&&results[primary].status==="ok",updatedAt:new Date().toISOString()}); delete out.secondary;
if(process.argv.indexOf("--no-write")<0)fs.writeFileSync(path.join(base,"valuation.json"),JSON.stringify(out,null,2));
console.log(JSON.stringify({ok:true,valuation:out}));
