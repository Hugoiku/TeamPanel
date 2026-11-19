"use strict";
/** Prefill method inputs from already structured research data; never overwrite analyst values. */
const fs=require("fs"),path=require("path");
const ROOT=path.resolve(__dirname,".."),CASE=process.argv[process.argv.indexOf("--case")+1]||"";
if(!CASE)process.exit(2);
const base=path.join(ROOT,"vault",CASE,"research");
const read=(p,d)=>{try{return JSON.parse(fs.readFileSync(path.join(base,p),"utf8"));}catch(e){return d;}};
const cfg=read("valuation.json",{method:"dcf",inputs:{},inputMeta:{}});
const model=read("investment-model.json",{}),stock=read("stock.json",{});
const method=cfg.method||"dcf";
const inputs=Object.assign({},cfg.inputs||{}),meta=Object.assign({},cfg.inputMeta||{});
const comps=(stock.valuation&&stock.valuation.comps)||{};
let peerFile=null;try{peerFile=JSON.parse(fs.readFileSync(path.join(base,"peer-multiples.json"),"utf8"));}catch(e){}
const candidates={};
if(method==="dcf"){
  candidates.revenue2026e=[model.revenue2026e,"investment-model"];
  candidates.wacc=[model.wacc,"investment-model"];
  candidates.g=[model.g,"investment-model"];
  candidates.terminalMargin=[model.terminalMargin,"investment-model"];
} else if(method==="comps"||method==="ev_sales"){
  candidates.metricValue=[model.revenue2026e,"investment-model.revenue2026e"];
  candidates.revenue=[model.revenue2026e,"investment-model.revenue2026e"];
  const pm=(peerFile&&peerFile.medianPs)||comps.peer_ps_median_7||comps.peer_ps_median_5_ex_crossborder;
  candidates.peerMultiple=[pm,"tushare.daily_basic.peer_ps_median"];
  candidates.multiple=[pm,"tushare.daily_basic.peer_ps_median"];
  if(peerFile&&peerFile.peers&&peerFile.peers.length)candidates.peers=[peerFile.peers.map(x=>({name:x.name||x.ts_code,multiple:x.ps_ttm})).filter(x=>x.multiple>0),"tushare.daily_basic.peers"];
  candidates.netCash=[model.netCash,"investment-model.netCash"];
  candidates.shares=[model.shares,"investment-model.shares"];
} else if(method==="nav"){
  candidates.assets=[stock.assets,"stock.assets"];
  candidates.liabilities=[stock.liabilities,"stock.liabilities"];
  candidates.shares=[model.shares,"investment-model.shares"];
} else if(method==="ddm"){
  candidates.dividend=[stock.dividend,"stock.dividend"];
  candidates.requiredReturn=[stock.requiredReturn,"stock.requiredReturn"];
} else if(method==="sotp"){
  candidates.segments=[stock.segments,"stock.segments"];
  candidates.netDebt=[stock.netDebt,"stock.netDebt"];
  candidates.shares=[model.shares,"investment-model.shares"];
}
const filled=[];
Object.keys(candidates).forEach(k=>{ const [v,src]=candidates[k]; if(v===undefined||v===null||v==="")return; if(inputs[k]!==undefined&&inputs[k]!==""&&inputs[k]!==null)return; inputs[k]=v; meta[k]={source:src,quality:"derived",asOf:new Date().toISOString().slice(0,10)}; filled.push(k); });
const out=Object.assign({},cfg,{inputs,inputMeta:meta,prefilled:filled,updatedAt:new Date().toISOString()});
fs.writeFileSync(path.join(base,"valuation.json"),JSON.stringify(out,null,2));
console.log(JSON.stringify({ok:true,filled,valuation:out}));
