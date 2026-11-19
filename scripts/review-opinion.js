"use strict";
const fs=require("fs"),path=require("path"),{spawnSync}=require("child_process");
const ROOT=path.resolve(__dirname,".."),CASE=(process.argv[process.argv.indexOf("--case")+1]||""),SERVICE=(process.argv[process.argv.indexOf("--service")+1]||"audit");
if(!CASE)process.exit(2);
const CFG=(()=>{try{return JSON.parse(fs.readFileSync(path.join(ROOT,"config/desk.json"),"utf8"));}catch(e){return{};}})();
const cfg=((CFG.models||{}).planner||{}).default||{provider:"opencode-go",model:"deepseek-v4.1-flash"};
let report="";try{report=fs.readFileSync(path.join(ROOT,"vault",CASE,"reports/investor-final.md"),"utf8").slice(0,12000);}catch(e){}
const prompt=["你是"+ (SERVICE==="legal"?"法务":"审计") +"复核员。阅读报告，输出独立复核意见。","只输出 JSON：{\"findings\":[{\"level\":\"pass|warn|fail\",\"text\":\"\"}]}","审计关注：数字与来源、预测标识、图表来源、内部流程词。","法务关注：免责声明、承诺性表述、引用授权、监管/版权风险。","不要编造未出现的问题；最多 6 条。","报告：",report].join("\n");
const patch=path.join(ROOT,"runtime/profiles/review-opinion.yml");fs.mkdirSync(path.dirname(patch),{recursive:true});
fs.writeFileSync(patch,["- id: agent-default-model",'  name: "@deepseek-ai/dsh-agent-default-model"',"  config:","    provider: "+cfg.provider,"    model: "+cfg.model,"    reasoningEffort: high","- id: llm-pi-ai",'  name: "@deepseek-ai/dsh-llm-pi-ai"',"  config:","    providers:","      "+cfg.provider+":","        apiKeyEnv: OPENCODE_GO_API_KEY",""].join("\n"));
let key=process.env.OPENCODE_GO_API_KEY||"";try{const m=fs.readFileSync(path.join(process.env.HOME||"",".dsh/.credentials.yaml"),"utf8").match(/OPENCODE_GO_API_KEY:\s*(\S+)/);if(m)key=m[1];}catch(e){}
const dsh=process.env.DSH_BIN||"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";const home=path.join(ROOT,"runtime/dsh-home","review-opinion");fs.mkdirSync(home,{recursive:true});
const r=spawnSync(dsh,["--patch",patch,"--profile","headless","--json",prompt],{cwd:ROOT,encoding:"utf8",timeout:120000,maxBuffer:16*1024*1024,env:Object.assign({},process.env,{OPENCODE_GO_API_KEY:key,DSH_HOME:home})});
let text="";String(r.stdout||"").split("\n").forEach(l=>{try{const j=JSON.parse(l);if(j.type==="final"&&typeof j.text==="string")text=j.text;}catch(e){}});
const m=text.match(/\{[\s\S]*\}/);let out={ok:false,findings:[]};try{if(m){const j=JSON.parse(m[0]);out={ok:true,findings:(j.findings||[]).slice(0,8)}}}catch(e){}
console.log(JSON.stringify(out));
