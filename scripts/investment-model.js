"use strict";
/** Analyst-editable DCF/forecast assumptions. */
const fs=require("fs"),path=require("path");
const ROOT=path.resolve(__dirname,".."),CASE=process.argv[process.argv.indexOf("--case")+1]||"";
if(!CASE)process.exit(2);
const base=path.join(ROOT,"vault",CASE,"research");
const defaults={revenue2026e:0,growth:[],fcfMargins:[],terminalMargin:0,wacc:0.11,g:0.03,netCash:0,shares:0,price:0,currency:"CNY",unit:"亿元"};
let m=Object.assign({},defaults);
try{const f=JSON.parse(fs.readFileSync(path.join(base,"investment-model.json"),"utf8"));m=Object.assign(m,f);}catch(e){}
function calc(x){
  let rev=Number(x.revenue2026e)||0, pv=0, lastFcf=0;
  if(!rev||!Number(x.shares))return {ev:0,equity:0,perShare:null,upsideDcf:null,needsSetup:true};
  for(let i=0;i<5;i++){ rev*= (1+(Number(x.growth[i])||0)); const fcf=rev*(Number(x.fcfMargins[i])||0); pv+=fcf/Math.pow(1+(Number(x.wacc)||0.11),i+1); lastFcf=fcf; }
  const terminalFcf=Number(x.terminalMargin)||0.15;
  const terminal=(rev*terminalFcf)*(1+(Number(x.g)||0))/((Number(x.wacc)||0.11)-(Number(x.g)||0));
  const ev=pv+terminal/Math.pow(1+(Number(x.wacc)||0.11),5);
  const equity=ev+(Number(x.netCash)||0); const per=equity/(Number(x.shares)||1);
  const price=Number(x.price)||0;
  return {ev,equity,perShare:Math.round(per*10)/10,upsideDcf:price?Math.round((per/price-1)*1000)/10:null};
}
const computed=calc(m);
const out=Object.assign({},m,{case:CASE,computed,updatedAt:new Date().toISOString()});
if(process.argv.indexOf("--init")>=0){fs.writeFileSync(path.join(base,"investment-model.json"),JSON.stringify({case:CASE,...m,computed,updatedAt:new Date().toISOString()},null,2));}
console.log(JSON.stringify({ok:true,model:out}));
