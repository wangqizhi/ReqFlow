export type Item={id:string;number:string;title:string;body:string;type:string;priority:string;status:string;criteria:string[];version:number;history:any[];aiValidation?:boolean;deliveryGuidance?:string;link?:string;executionVersion?:number;archived?:boolean};
export type Project={id:string;name:string;description:string;guidance:string;guideVersion:number;guideHistory:any[];deliveryGuidance:string;aiValidation:boolean;items:Item[];batches:any[];nextNumber:number};
export type Workspace={projects:Project[]};
export const DEFAULT_DELIVERY='说明改动、测试命令和结果、未解决的问题。';
export const DEFAULT_GUIDANCE='请结合项目背景实现需求，遵循现有技术栈与代码规范。完成后说明改动、运行方式、验证结果与剩余问题。';
export function requirementSettings(p:Project,i:Item){const aiValidation=i.aiValidation??p.aiValidation;const delivery=i.deliveryGuidance??p.deliveryGuidance;return {aiValidation,deliveryGuidance:!aiValidation&&delivery===DEFAULT_DELIVERY?'说明改动、未解决的问题。':delivery};}
export function buildPrompt(p:Project,items:Item[]){const anyValidation=items.some(i=>requirementSettings(p,i).aiValidation);const guidance=!anyValidation&&p.guidance===DEFAULT_GUIDANCE?p.guidance.replace('、验证结果',''):p.guidance;return '# 项目：'+p.name+'\n\n## 项目上下文\n'+p.description+'\n\n## 引导词 · v'+p.guideVersion+'\n'+guidance+'\n\n## 本轮目标\n实现以下需求，按列出的顺序执行。\n\n'+items.map((i,n)=>{const settings=requirementSettings(p,i);return '### '+(n+1)+'. '+i.number+' · '+i.title+' ['+i.type+' / '+i.priority+']\n'+i.body+(unresolvedFailures(i).length?'\n\n未通过的问题（本轮需修复）：\n'+unresolvedFailures(i).map((f,j)=>'- '+(j+1)+'. '+f.note).join('\n'):'')+(i.criteria.length?'\n\n验收条件：\n'+i.criteria.map(c=>'- [ ] '+c).join('\n'):'')+(settings.aiValidation?'\n\nAI 测试验证（仅适用于 '+i.number+'）：\n完成此需求后执行适合本次改动的检查或测试，并如实说明结果；无法执行时说明原因。':'')+'\n\n交付引导（'+i.number+'）：\n'+settings.deliveryGuidance;}).join('\n\n');}
export function unresolvedFailures(i:Item){const notes:any[]=[];for(const h of i.history){if(h.event==='验证通过')break;if(h.event==='验证失败'||h.event==='回归退回')notes.push({time:h.time,note:h.note||'验证未通过，请重新检查需求实现。'});}return notes.reverse();}
export function normalizeWorkspace(s:Workspace){for(const p of s.projects){if(typeof p.deliveryGuidance!=='string')p.deliveryGuidance=DEFAULT_DELIVERY;if(typeof p.aiValidation!=='boolean')p.aiValidation=true;for(const i of p.items){if(i.archived||i.status==='verified'){i.status='archived';i.archived=true;}else if(i.status==='draft'){i.status='ready';i.version++;}}}return s;}
export const makeProject=(name:string,description=''):Project=>({id:crypto.randomUUID(),name,description,guidance:DEFAULT_GUIDANCE,guideVersion:1,guideHistory:[],deliveryGuidance:DEFAULT_DELIVERY,aiValidation:true,items:[],batches:[],nextNumber:1});
const needed=(v:any,label:string)=>{if(typeof v!=='string'||!v.trim())throw new Error('请填写'+label);return v.trim()};
export async function apply(s:Workspace,a:any){
 normalizeWorkspace(s);
 if(a.op==='project'){s.projects.push(makeProject(needed(a.name,'项目名称'),String(a.description||'')));return;}
 const p=s.projects.find(p=>p.id===a.project);if(!p)throw new Error('项目不存在');const now=new Date().toISOString();
 if(a.op==='guidance'){const text=needed(a.text,'项目引导词');const delivery=a.deliveryGuidance===undefined?p.deliveryGuidance:needed(a.deliveryGuidance,'交付引导');if(a.aiValidation!==undefined&&typeof a.aiValidation!=='boolean')throw new Error('AI 验证设置无效');p.guideHistory.unshift({version:p.guideVersion,text:p.guidance,deliveryGuidance:p.deliveryGuidance,aiValidation:p.aiValidation,time:now});p.guidance=text;p.deliveryGuidance=delivery;p.aiValidation=a.aiValidation===undefined?p.aiValidation:a.aiValidation;p.guideVersion++;return;}
 if(a.op==='item'){
 const title=needed(a.title,'标题');const criteria=String(a.criteria||'').split('\n').map(x=>x.trim()).filter(Boolean);
 const existing=p.items.find(i=>i.id===a.id);const aiValidation=a.aiValidation??existing?.aiValidation??p.aiValidation;if(typeof aiValidation!=='boolean')throw new Error('AI 测试验证设置无效');const deliveryGuidance=a.deliveryGuidance===undefined?(existing?.deliveryGuidance??p.deliveryGuidance):needed(a.deliveryGuidance,'交付引导');
 if(!['feature','improvement','bug'].includes(a.type)||!['P0','P1','P2'].includes(a.priority))throw new Error('类型或优先级无效');
 let i=p.items.find(i=>i.id===a.id);if(i){if(!['draft','ready'].includes(i.status))throw new Error('请先取消执行或退回，再编辑需求');i.history.unshift({event:'编辑',time:now,snapshot:{...i,history:undefined}});Object.assign(i,{title,body:String(a.body||''),criteria,aiValidation,deliveryGuidance,type:a.type,priority:a.priority,status:'ready',version:i.version+1});}
 else p.items.push({id:crypto.randomUUID(),number:'REQ-'+String(p.nextNumber++).padStart(3,'0'),title,body:String(a.body||''),criteria,aiValidation,deliveryGuidance,type:a.type,priority:a.priority,status:'ready',version:1,history:[{event:'创建',time:now}]});return;}
 if(a.op==='generate'){
 if(a.mode&&a.mode!=='develop')throw new Error('已取消协助验证模式，请从待执行需求生成 Prompt');const mode='develop';const items=(a.ids||[]).map((id:string)=>p.items.find(i=>i.id===id));if(!items.length||items.some((i:Item)=>!i||i.archived||i.status!=='ready'))throw new Error('请选择待执行的需求');
 const snapshots=items.map((i:Item)=>({...structuredClone(i),...requirementSettings(p,i)}));const text=buildPrompt(p,snapshots);
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(x=>x.toString(16).padStart(2,'0')).join('');
 p.batches.unshift({id:crypto.randomUUID(),number:p.batches.length+1,mode,status:'draft',text,hash,guideVersion:p.guideVersion,templateVersion:4,items:snapshots,time:now});return;}
 if(a.op==='submit'||a.op==='cancel'){
 const b=p.batches.find(b=>b.id===a.batch);if(!b)throw new Error('批次不存在');if(a.op==='submit'){
 if(b.status!=='draft'||b.mode!=='develop')throw new Error('该批次不能提交');if(b.guideVersion!==p.guideVersion||b.items.some((old:Item)=>{const i=p.items.find(i=>i.id===old.id);return !i||i.version!==old.version||i.status!=='ready'||i.archived}))throw new Error('源内容或状态已变化，请重新生成批次');
 b.status='submitted';b.submittedAt=now;b.items.forEach((old:Item)=>{const i=p.items.find(i=>i.id===old.id)!;i.status='in_progress';i.executionVersion=old.version;i.history.unshift({event:'确认提交 · 批次 '+b.number,time:now});});
 }else{if(b.status!=='submitted')throw new Error('只能取消已提交批次');b.status='cancelled';b.items.forEach((old:Item)=>{const i=p.items.find(i=>i.id===old.id);if(i?.status==='in_progress'){i.status='ready';i.history.unshift({event:'取消执行',time:now});}});}return;}
 const i=p.items.find(i=>i.id===a.id);if(!i)throw new Error('需求不存在');
 if(a.op==='ready'){if(i.status!=='draft')throw new Error('只有草稿可标记待提交');i.status='ready';i.version++;i.history.unshift({event:'标记待提交',time:now});return;}
 if(a.op==='complete'){if(i.status!=='in_progress')throw new Error('需求不在执行中');i.status='pending_verification';i.link=String(a.link||'');i.history.unshift({event:'实现完成',time:now,link:i.link,note:String(a.note||'')});return;}
 if(a.op==='verify'){if(i.status!=='pending_verification')throw new Error('需求不在待验证');if(typeof a.pass!=='boolean')throw new Error('请确认验证结果');if(a.pass&&i.executionVersion!==i.version)throw new Error('需求版本已变化，请重新实现后验证');i.history.unshift({event:a.pass?'验证通过':'验证失败',time:now,note:String(a.note||''),confirmation:'用户手动确认',version:i.version});if(a.pass){i.status='archived';i.archived=true;i.status='archived';i.history.unshift({event:'归档',time:now,reason:'验证通过后自动归档'});}else{i.status='ready';i.archived=false;i.version++;}return;}
 if(a.op==='regress'){if(!i.archived&&i.status!=='archived')throw new Error('需求尚未归档');i.history.unshift({event:'回归退回',time:now,note:String(a.note||'')});i.status='ready';i.archived=false;i.version++;return;}
 if(a.op==='archive'){if(i.status==='in_progress')throw new Error('请先取消执行');i.archived=true;i.status='archived';i.history.unshift({event:'归档',time:now});return;}
 throw new Error('未知操作');
}
