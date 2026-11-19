"use strict";
const fs=require("fs"),path=require("path");
const ROOT=path.resolve(__dirname,".."),CASE=process.argv[process.argv.indexOf("--case")+1]||"";
if(!CASE)process.exit(2);
const vault=path.join(ROOT,"vault",CASE),base=path.join(vault,"research");
const read=(p,d)=>{try{return JSON.parse(fs.readFileSync(path.join(base,p),"utf8"));}catch(e){return d;}};
const pm=read("peer-multiples.json",{peers:[]}),stock=read("stock.json",{});
const ps=pm.peers.map(x=>Number(x.ps_ttm)).filter(x=>isFinite(x)&&x>0).sort((a,b)=>a-b);
const pe=pm.peers.map(x=>Number(x.pe_ttm)).filter(x=>isFinite(x)&&x>0).sort((a,b)=>a-b);
const med=a=>a.length?(a[Math.floor((a.length-1)/2)]+a[Math.ceil((a.length-1)/2)])/2:null;
const targetCode=((stock.primary&&stock.primary.code)||"").slice(0,6);
const target=pm.peers.find(x=>String(x.ts_code||"").slice(0,6)===targetCode);
const pct=(v,a)=>{if(v==null||!a.length)return null;let n=0;for(const x of a)if(x<=v)n++;return Math.round(n/a.length*1000)/10;};
const histPath=path.join(base,"industry-valuation-history.jsonl");const hist=[];try{for(const l of fs.readFileSync(histPath,"utf8").split(String.fromCharCode(10))){if(!l.trim())continue;try{const x=JSON.parse(l);if(x.psMedian)hist.push(x.psMedian);}catch(e){}}}catch(e){}
const median=med(ps);const histPct=median!=null&&hist.length?Math.round(hist.filter(x=>x<=median).length/hist.length*1000)/10:null;
const out={case:CASE,count:pm.count||ps.length,psMedian:median,psMin:ps[0]||null,psMax:ps[ps.length-1]||null,peMedian:med(pe),historySamples:hist.length,historyPercentile:histPct,target:target?{code:target.ts_code,name:target.name,ps:target.ps_ttm,psPercentile:pct(Number(target.ps_ttm),ps)}:null,generatedAt:new Date().toISOString()};
try{fs.appendFileSync(histPath,JSON.stringify({at:out.generatedAt,psMedian:out.psMedian,psMin:out.psMin,psMax:out.psMax})+String.fromCharCode(10));}catch(e){}
fs.writeFileSync(path.join(base,"industry-valuation.json"),JSON.stringify(out,null,2));
console.log(JSON.stringify({ok:true,valuation:out}));
