"use strict";
const fs=require("fs"),path=require("path");
const ROOT=path.resolve(__dirname,".."),CASE=process.argv[process.argv.indexOf("--case")+1]||"";
if(!CASE)process.exit(2);
const base=path.join(ROOT,"vault",CASE,"research");
let dict={fields:{}};try{dict=JSON.parse(fs.readFileSync(path.join(ROOT,"config/financial-fields.json"),"utf8"));}catch(e){}
let stock={};try{stock=JSON.parse(fs.readFileSync(path.join(base,"stock.json"),"utf8"));}catch(e){}
const flat={};
(function walk(o,p){if(o&&typeof o==="object"){Object.keys(o).forEach(k=>{const q=p?p+"."+k:k;if(o[k]&&typeof o[k]==="object")walk(o[k],q);else flat[q]=o[k];});}})(stock,"");
const out={case:CASE,authority:"tushare",asOf:"",fields:{},unmapped:[]};
const a=stock.assumptions||{};
const special={
  revenue:{value:a.revenue_2026e_yi,source:"assumptions.revenue_2026e_yi",unit:"亿元"},
  net_debt:{value:a.net_cash_yi!=null?-Number(a.net_cash_yi):null,source:"assumptions.net_cash_yi（取负）",unit:"亿元"},
  shares:{value:a.shares_yi,source:"assumptions.shares_yi",unit:"亿股"},
  eps:{value:null,source:"",unit:"元"}
};
const fin=stock.financials||{};
const nk=s=>String(s||"").replace(/_/g,"").toLowerCase();
let tushare=null;try{tushare=JSON.parse(fs.readFileSync(path.join(base,"financials-tushare.json"),"utf8"));}catch(e){}
if(tushare&&tushare.fields){out.asOf=tushare.asOf||"";Object.keys(tushare.fields).forEach(k=>{const x=tushare.fields[k];if(x&&x.value!=null)special[k]={value:x.value,source:x.source||"tushare",unit:x.unit||(dict.fields[k]&&dict.fields[k].unit)||""};});}
Object.keys(fin).forEach(k=>{const x=fin[k];if(!x||typeof x!=="object"||x.value==null)return;const target=Object.keys(dict.fields||{}).find(d=>nk(d)===nk(k))||k;if(special[target]&&special[target].value!=null)return;special[target]={value:x.value,source:x.source||("financials."+k),unit:x.unit||(dict.fields[target]&&dict.fields[target].unit)||""};});
Object.keys(dict.fields||{}).forEach(k=>{const f=dict.fields[k];if(special[k]&&special[k].value!=null){out.fields[k]=special[k];return;}const hits=Object.keys(flat).filter(q=>f.aliases.some(a0=>q.toLowerCase().endsWith(String(a0).toLowerCase())) && (typeof flat[q]==="number" || /^-?\d+(?:\.\d+)?$/.test(String(flat[q]).trim())));if(hits.length)out.fields[k]={value:flat[hits[0]],source:hits[0],unit:f.unit};else out.unmapped.push(k);});
fs.writeFileSync(path.join(base,"financials.json"),JSON.stringify(out,null,2));
console.log(JSON.stringify({ok:true,...out}));
