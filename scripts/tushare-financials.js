"use strict";
const https=require("https"),fs=require("fs"),path=require("path");
const ROOT=path.resolve(__dirname,".."),CASE=process.argv[process.argv.indexOf("--case")+1]||"";
if(!CASE)process.exit(2);
const vault=path.join(ROOT,"vault",CASE),base=path.join(vault,"research");
function token(){try{return JSON.parse(fs.readFileSync(path.join(ROOT,"runtime/secrets/tushare.json"),"utf8")).token;}catch(e){return "";}}
function post(body){return new Promise((res,rej)=>{const data=JSON.stringify(body);const r=https.request({hostname:"api.tushare.pro",path:"/",method:"POST",headers:{"content-type":"application/json","content-length":Buffer.byteLength(data)}},x=>{let s="";x.on("data",d=>s+=d);x.on("end",()=>{try{res(JSON.parse(s))}catch(e){rej(e)}})});r.on("error",rej);r.write(data);r.end();});}
function obj(fields,row){const o={};fields.forEach((k,i)=>o[k]=row[i]);return o;}
(async()=>{
  let stock={};try{stock=JSON.parse(fs.readFileSync(path.join(base,"stock.json"),"utf8"));}catch(e){}
  const ci=process.argv.indexOf("--ts-code");
  let code=String((ci>=0?process.argv[ci+1]:"")||((stock.primary&&stock.primary.code)||"")).trim();
  if(!code)throw new Error("ts_code required");
  const calls={};
  for(const api of ["income","balancesheet","cashflow","fina_indicator","daily_basic"]){
    const j=await post({api_name:api,token:token(),params:{ts_code:code,start_date:"20250101",end_date:"20261231"},fields:""});
    if(j.code!==0)throw new Error(api+": "+(j.msg||j.code));
    const f=(j.data&&j.data.fields)||[],rows=(j.data&&j.data.items)||[];
    const objs=rows.map(r=>obj(f,r)).filter(x=>x.end_date||x.trade_date);
    objs.sort((a,b)=>String(b.end_date||b.trade_date).localeCompare(String(a.end_date||a.trade_date)));
    calls[api]=objs[0]||{};
  }
  const inc=calls.income||{},bs=calls.balancesheet||{},cf=calls.cashflow||{},fi=calls.fina_indicator||{},db=calls.daily_basic||{};
  const yi=x=>x==null?null:Math.round(Number(x)/1e8*1000)/1000;
  const pct=x=>x==null?null:Math.round(Number(x)*100)/100;
  const capex=yi(cf.c_pay_acq_const_fiolta);
  const ocf=yi(cf.n_cashflow_act);
  const debtParts={st_borr:bs.st_borr,lt_borr:bs.lt_borr,bond_payable:bs.bond_payable,st_bonds_payable:bs.st_bonds_payable,non_cur_liab_due_1y:bs.non_cur_liab_due_1y,lease_liab:bs.lease_liab};
  const debtTotal=Object.keys(debtParts).reduce((a,k)=>a+Number(debtParts[k]||0),0);
  const fields={
    revenue:{value:yi(inc.total_revenue||inc.revenue),unit:"亿元",source:"tushare income "+(inc.end_date||"")},
    gross_margin:{value:pct(fi.grossprofit_margin),unit:"%",source:"tushare fina_indicator "+(fi.end_date||"")},
    net_profit:{value:yi(inc.n_income_attr_p),unit:"亿元",source:"tushare income "+(inc.end_date||"")},
    capex:{value:capex,unit:"亿元",source:"tushare cashflow "+(cf.end_date||"")},
    fcf:{value:(ocf!=null&&capex!=null)?Math.round((ocf-capex)*1000)/1000:null,unit:"亿元",source:"tushare cashflow（经营现金流-资本开支）"},
    net_debt:{value:(debtTotal||bs.money_cap)?yi(debtTotal-Number(bs.money_cap||0)):null,unit:"亿元",source:"tushare balancesheet 有息负债合计−货币资金",components:debtParts},
    shares:{value:db.total_share!=null?Math.round(Number(db.total_share)/1e4*10000)/10000:null,unit:"亿股",source:"tushare daily_basic total_share（万股→亿股）"},
    eps:{value:inc.basic_eps!=null?Number(inc.basic_eps):null,unit:"元",source:"tushare income "+(inc.end_date||"")},
    operating_margin:{value:pct(fi.op_of_gr),unit:"%",source:"tushare fina_indicator op_of_gr "+(fi.end_date||"")},
    net_interest_margin:{value:pct(fi.net_interest_margin),unit:"%",source:"tushare fina_indicator "+(fi.end_date||"")},
    npl_ratio:{value:pct(fi.npl_ratio),unit:"%",source:"tushare fina_indicator "+(fi.end_date||"")},
    provision_coverage:{value:pct(fi.provision_coverage),unit:"%",source:"tushare fina_indicator "+(fi.end_date||"")},
    cet1_ratio:{value:pct(fi.cet1_ratio),unit:"%",source:"tushare fina_indicator "+(fi.end_date||"")},
    core_tier1_ratio:{value:pct(fi.core_tier1_ratio),unit:"%",source:"tushare fina_indicator "+(fi.end_date||"")},
    loan_deposit_ratio:{value:pct(fi.loan_deposit_ratio),unit:"%",source:"tushare fina_indicator "+(fi.end_date||"")},
    nbv:{value:yi(fi.nbv),unit:"亿元",source:"tushare fina_indicator "+(fi.end_date||"")},
    ev:{value:yi(fi.ev),unit:"亿元",source:"tushare fina_indicator "+(fi.end_date||"")},
    solvency_ratio:{value:pct(fi.solvency_ratio),unit:"%",source:"tushare fina_indicator "+(fi.end_date||"")},
    combined_ratio:{value:pct(fi.combined_ratio),unit:"%",source:"tushare fina_indicator "+(fi.end_date||"")}
  };
  const out={case:CASE,ts_code:code,asOf:inc.end_date||bs.end_date||cf.end_date||"",currency:"CNY",unit:"亿元",fields,raw:{income:inc,balancesheet:bs,cashflow:cf,fina_indicator:fi,daily_basic:db},generatedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(base,"financials-tushare.json"),JSON.stringify(out,null,2));
  console.log(JSON.stringify({ok:true,ts_code:code,asOf:out.asOf,fields}));
})().catch(e=>{console.log(JSON.stringify({ok:false,error:String(e&&e.message||e)}));process.exit(1)});
