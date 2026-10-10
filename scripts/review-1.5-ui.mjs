import { build } from 'esbuild';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
const dir = await mkdtemp(path.join(os.tmpdir(), 'reqflow-1.5-ui-'));
const output = path.resolve('out/review-1.5.0'); await mkdir(output, { recursive: true });
try {
  const entry = path.join(dir, 'ipc.ts');
  await writeFile(entry, `export { registerIpc } from ${JSON.stringify(path.resolve('src/main/ipc.ts'))};`);
  await build({ entryPoints: [entry], outfile: path.join(dir, 'ipc.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
  const host = path.join(dir, 'host.cjs');
  await writeFile(host, `
const {app,BrowserWindow}=require('electron');const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(path.join(dir, 'profile'))});
app.whenReady().then(async()=>{try{
 const root=${JSON.stringify(dir)},output=${JSON.stringify(output)};require('./ipc.cjs').registerIpc(path.join(root,'data'));
 const win=new BrowserWindow({width:1440,height:900,show:false,webPreferences:{preload:${JSON.stringify(path.resolve('dist/preload/index.js'))},sandbox:false,contextIsolation:true,nodeIntegration:false}});
 await win.loadFile(${JSON.stringify(path.resolve('dist/renderer/index.html'))});win.setPosition(-2000,-2000);win.show();win.webContents.focus();
 const js=async s=>{try{return await win.webContents.executeJavaScript(s)}catch(e){console.error(s);throw e}},wait=async s=>{for(let i=0;i<150;i++){if(await js(s))return;await new Promise(r=>setTimeout(r,50));}throw Error('timeout '+s)};
 const click=text=>js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(text)+').click()');
 const tab=name=>js('Array.from(document.querySelectorAll(".navtabs button")).find(b=>b.textContent.includes('+JSON.stringify(name)+')).click()');
 const apply=async a=>{const r=await js('window.reqflow.apply('+JSON.stringify(a)+')');assert.equal(r.ok,true,JSON.stringify(r));return r};
 const fill=(selector,value)=>js('(()=>{let e=document.querySelector('+JSON.stringify(selector)+');Object.getOwnPropertyDescriptor(e.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value").set.call(e,'+JSON.stringify(value)+');e.dispatchEvent(new Event("input",{bubbles:true}));})()');
 const bodies=()=>js('Array.from(document.querySelectorAll(".req-card .body-copy")).map(e=>e.textContent)');
 async function gesture(selector,to){const xy=await js('(()=>{let r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return [Math.round(r.left+20),Math.round(r.top+15)]})()');win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:xy[0],y:xy[1]});win.webContents.sendInputEvent({type:'mouseMove',x:to[0],y:to[1]});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:to[0],y:to[1]});await new Promise(r=>setTimeout(r,100));}
 async function background(){const xy=await js('[innerWidth-8,innerHeight-8]');win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:xy[0],y:xy[1]});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:xy[0],y:xy[1]});await new Promise(r=>setTimeout(r,100));}
 const shot=async name=>{win.setPosition(20,20);win.webContents.invalidate();await new Promise(r=>setTimeout(r,400));await fs.writeFile(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());win.setPosition(-2000,-2000);};
 await wait('!!document.querySelector(".navtabs")');const A=(await js('window.reqflow.getWorkspace()')).state.projects[0].id;
 const now=new Date(),today=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
 const ids=[];for(const [body,scheduledDate] of [['Past','2000-01-01'],['Today',today],['Future','2999-12-31'],['Undated','']]){const r=await apply({op:'item',project:A,body,scheduledDate});ids.push(r.state.projects[0].items.at(-1).id);}
 let r=await apply({op:'generate',project:A,ids});await apply({op:'submit',project:A,batch:r.state.projects[0].batches[0].id});
 r=await apply({op:'project',name:'External agent project'});const B=r.state.projects.at(-1).id;
 await js('document.querySelector("[aria-label=刷新数据]").click()');await wait('document.querySelector(".navtabs").textContent.includes("排期表4")');
 // UI sees old global version but A's revision is unchanged by B's external write.
 await apply({op:'projectDescription',project:B,description:'external agent edit'});
 await click('记录新需求');await wait('!!document.querySelector(".requirement-dialog")');await fill('.requirement-dialog textarea','New dated UI requirement');await fill('[aria-label=需求计划日期]','2030-03-04');await shot('requirement-date');win.setSize(1440,650);await new Promise(r=>setTimeout(r,100));assert.equal(await js('document.querySelector(".requirement-dialog .editor-footer button").getBoundingClientRect().bottom < innerHeight'),true);await shot('requirement-date-short');win.setSize(1440,900);await new Promise(r=>setTimeout(r,100));await click('保存需求');await wait('!document.querySelector(".requirement-dialog")');
 r=await js('window.reqflow.getWorkspace()');assert.equal(r.state.projects.find(p=>p.id===B).description,'external agent edit');assert.equal(r.state.projects[0].items.at(-1).scheduledDate,'2030-03-04');
 await tab('排期表');await wait('!!document.querySelector(".schedule-filter")');assert.deepEqual((await bodies()).sort(),['Past','Today','Undated'].sort());assert.equal(await js('document.querySelector("[aria-label=排期筛选日期]").value'),today);
 await click('指定日期');assert.deepEqual(await bodies(),['Today']);await fill('[aria-label=排期筛选日期]','2999-12-31');assert.deepEqual(await bodies(),['Future']);await click('所有需求');assert.equal((await bodies()).length,4);
 await click('日期及之前');await fill('[aria-label=排期筛选日期]',today);await shot('schedule-date');
 // Range-limited top action must not submit hidden future requirements.
 await click('指定日期');await js('document.querySelector(".gen-actions .primary").click()');await wait('document.querySelector(".navtabs .active").textContent.includes("待验证")');r=await js('window.reqflow.getWorkspace()');assert.equal(r.state.projects[0].items.filter(i=>i.status==='pending_verification').length,1);assert.equal(r.state.projects[0].items.find(i=>i.body==='Future').status,'in_progress');
 const hashes=r.state.projects[0].batches.map(b=>b.hash);await tab('归档');await wait('!!document.querySelector(".archive-navigation")');assert.equal(await js('document.querySelectorAll(".navtabs button").length'),4);await js('document.querySelector(".archive-navigation button:last-child").click()');await wait('!!document.querySelector(".batch-list")');assert.equal(await js('document.querySelectorAll(".batch-card").length'),hashes.length);await shot('archive-batches');await js('document.querySelector(".batch-open").click()');await wait('document.querySelector(".navtabs .active").textContent.includes("排期表")');assert.deepEqual((await js('window.reqflow.getWorkspace()')).state.projects[0].batches.map(b=>b.hash),hashes);
 // Dragging/selecting from dialog content onto backdrop must not dismiss it.
 await click('记录新需求');await wait('!!document.querySelector(".requirement-dialog")');await fill('.requirement-dialog textarea','unsaved retained');await gesture('.requirement-dialog textarea',[8,8]);assert.equal(await js('document.querySelector(".requirement-dialog textarea").value'),'unsaved retained');await gesture('.requirement-dialog .dialog-head',[8,8]);assert.equal(await js('!!document.querySelector(".requirement-dialog")'),true);await background();await wait('!document.querySelector(".requirement-dialog")');
 const files=path.join(root,'files');await fs.mkdir(files);await apply({op:'projectDir',project:A,dir:files});await js('document.querySelector("[aria-label=刷新数据]").click()');await wait('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.trim()==="浏览项目")');await click('浏览项目');await wait('!!document.querySelector(".fb")');await js('document.querySelector("[aria-label=项目仓库设置]").click()');await wait('!!document.querySelector(".project-remote-overlay")');await gesture('.project-remote-overlay input',[8,8]);assert.equal(await js('!!document.querySelector(".project-remote-overlay") && !!document.querySelector(".fb")'),true);await background();await wait('!document.querySelector(".project-remote-overlay")');assert.equal(await js('!!document.querySelector(".fb")'),true);
 console.log('PASS 1.5 UI: archive-only batch entry/data preserved, local-date entry and through/exact/all filters, range-limited submit, unrelated agent edit survives UI save, inside-to-backdrop gestures retained, genuine outside click still closes, nested overlay does not close parent');win.destroy();app.exit(0);
}catch(e){console.error(e);app.exit(1);}});
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const result=await new Promise(resolve=>execFile(path.resolve('node_modules/electron/dist/electron.exe'),[host],{env,windowsHide:true,timeout:120000,maxBuffer:4*1024*1024},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
  console.log(result.stdout);if(result.error)throw Error(result.stderr||result.error.message);
} finally {await rm(dir,{recursive:true,force:true});}
