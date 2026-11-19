"use strict";
const fs=require("fs"),path=require("path");
const arg=(n,d)=>{const i=process.argv.indexOf("--"+n);return i>=0?process.argv[i+1]:d;};
const ROOT=path.resolve(__dirname,"..");
const value=arg("value",""), unit=arg("unit",""), asOf=arg("asOf",""), url=arg("url",""), source=arg("source",""), expectedUnit=arg("expectedUnit","");
const otherValue=arg("otherValue",""), otherSource=arg("otherSource","");
const coverage=arg("coverage",""), expectedMin=arg("expectedMin",""), expectedMax=arg("expectedMax","");
const history=String(arg("history","")||"").split(",").map(x=>Number(x.trim())).filter(x=>!isNaN(x));
const periodsExpected=Number(arg("periodsExpected",""))||0, periodsActual=Number(arg("periodsActual",""))||0;
const checks=[]; let needsHuman=false;
const n=Number(String(value).replace(/[,，%]/g,""));
checks.push({id:"numeric",label:"数值可解析",level:isNaN(n)?"fail":"pass",detail:isNaN(n)?"无法解析为数字":String(n)});
if(expectedUnit){const ok=String(unit||"").indexOf(expectedUnit)>=0||String(expectedUnit).indexOf(String(unit||""))>=0;checks.push({id:"unit",label:"单位一致",level:ok?"pass":"warn",detail:"期望 "+expectedUnit+"，实际 "+unit});if(!ok)needsHuman=true;}
if(!unit){checks.push({id:"unit_missing",label:"单位缺失",level:"warn",detail:"未提供单位"});needsHuman=true;}
if(asOf){const t=new Date(asOf+"T00:00:00").getTime();const now=Date.now();const ok=!isNaN(t)&&t<=now;checks.push({id:"date",label:"数据日期有效",level:ok?"pass":"fail",detail:asOf});if(!ok)needsHuman=true;if(ok&&now-t>180*86400000){checks.push({id:"stale",label:"数据时效",level:"warn",detail:"超过180天"});needsHuman=true;}}else{checks.push({id:"date_missing",label:"数据日期缺失",level:"warn",detail:"未提供日期"});needsHuman=true;}
if(!/^https?:\/\//.test(url||"")){checks.push({id:"source",label:"来源 URL",level:"warn",detail:"非 http(s) 来源"});needsHuman=true;}else{checks.push({id:"source",label:"来源 URL",level:"pass",detail:url});}
if(source){checks.push({id:"source_tier",label:"来源类型",level:"pass",detail:source});}
if(periodsExpected>0){const miss=Math.max(0,periodsExpected-periodsActual);const ok=miss===0;checks.push({id:"periods",label:"缺失期检测",level:ok?"pass":"warn",detail:ok?"无缺期":"缺 "+miss+" 期"});if(!ok)needsHuman=true;}
if(history.length>=3&&!isNaN(n)){const avg=history.reduce((a,b)=>a+b,0)/history.length;const sd=Math.sqrt(history.reduce((a,b)=>a+(b-avg)*(b-avg),0)/history.length);if(sd>0){const z=Math.abs(n-avg)/sd;const ok=z<=2.5;checks.push({id:"history",label:"历史一致性",level:ok?"pass":"warn",detail:"偏离 "+z.toFixed(1)+"σ"});if(!ok)needsHuman=true;}} 
if(coverage!==""&&!isNaN(Number(coverage))){const cv=Number(coverage);const ok=cv>=95;checks.push({id:"coverage",label:"数据完整性",level:cv<70?"fail":(ok?"pass":"warn"),detail:"覆盖率 "+cv+"%"});if(!ok)needsHuman=true;}
if(expectedMin!==""&&!isNaN(Number(expectedMin))&&!isNaN(n)&&n<Number(expectedMin)){checks.push({id:"range_min",label:"低于合理区间",level:"warn",detail:n+" < "+expectedMin});needsHuman=true;}
if(expectedMax!==""&&!isNaN(Number(expectedMax))&&!isNaN(n)&&n>Number(expectedMax)){checks.push({id:"range_max",label:"高于合理区间",level:"warn",detail:n+" > "+expectedMax});needsHuman=true;}
if(otherValue!==""&&!isNaN(Number(otherValue))&&!isNaN(n)&&n!==0){const diff=Math.abs(n-Number(otherValue))/Math.abs(n)*100;const ok=diff<=5;checks.push({id:"cross_source",label:"多源交叉",level:ok?"pass":"warn",detail:(otherSource||"第二来源")+"="+otherValue+"，差异 "+diff.toFixed(1)+"%"});if(!ok)needsHuman=true;}
const fails=checks.filter(x=>x.level==="fail").length, warns=checks.filter(x=>x.level==="warn").length;
const quality=fails?"low":(warns?"medium":"high");
console.log(JSON.stringify({ok:!fails,quality,needsHuman:needsHuman||fails>0||warns>0,checks,value:n,unit,asOf,url,source}));
