import { build } from 'esbuild';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const temp = await mkdtemp(path.join(os.tmpdir(), 'reqflow-delivery-ui-'));
const output = path.resolve('out/review-1.10.4');
try {
  await mkdir(output, { recursive: true });
  await build({ entryPoints: ['src/main/ipc.ts'], outfile: path.join(temp, 'ipc.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
  const seed = `(async()=>{const r=await window.reqflow.getWorkspace();const p=r.state.projects[0];await window.reqflow.apply({op:'projectDir',project:p.id,dir:${JSON.stringify(process.cwd())}});for(let n=0;n<30;n++)await window.reqflow.apply({op:'item',project:p.id,body:'测试任务 '+n});const latest=await window.reqflow.getWorkspace();const items=latest.state.projects[0].items;const generated=await window.reqflow.apply({op:'generate',project:p.id,ids:items.map(i=>i.id)});await window.reqflow.apply({op:'submit',project:p.id,batch:generated.state.projects[0].batches[0].id});})()`;
  const host = `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
app.setPath('userData', ${JSON.stringify(path.join(temp, 'profile'))});
app.whenReady().then(async () => {
 let win;
 try {
  require('./ipc.cjs').registerIpc(${JSON.stringify(path.join(temp, 'data'))});
  win = new BrowserWindow({width:1440,height:900,show:false,webPreferences:{preload:${JSON.stringify(path.resolve('dist/preload/index.js'))},sandbox:false,backgroundThrottling:false}});
  await win.loadFile(${JSON.stringify(path.resolve('dist/renderer/index.html'))});
  const js = source => win.webContents.executeJavaScript(source);
  const wait = async source => { for(let i=0;i<100;i++){if(await js(source))return;await new Promise(r=>setTimeout(r,50));}throw Error('UI timeout: '+source); };
  const click = text => js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(text)+').click()');
  await wait('!!document.querySelector(".project-background")');
  await js(${JSON.stringify(seed)});
  await js('document.querySelector("[aria-label=刷新数据]").click()');
  await wait('document.querySelector(".guidance .linked-dir")');
  await js('Array.from(document.querySelectorAll(".navtab")).find(b=>b.textContent.startsWith("排期表")).click()');
  await wait('!!document.querySelector(".gen-panel")');
  assert.equal(await js('!!document.querySelector(".title-row .linked-dir")'), false);
  assert.equal(await js('document.querySelector(".requirements").lastElementChild.classList.contains("gen-panel")'),true);
  const panelY = await js('document.querySelector(".gen-panel").getBoundingClientRect().y');
  await js('document.querySelector(".list-scroll").scrollTop=99999');
  assert.equal(await js('document.querySelector(".gen-panel").getBoundingClientRect().y'), panelY);
  await fs.writeFile(${JSON.stringify(path.join(output, 'schedule-1440.png'))},(await win.webContents.capturePage()).toPNG());
  win.setSize(1440,700);
  await new Promise(r=>setTimeout(r,150));
  assert.ok(await js('document.querySelector(".gen-panel").getBoundingClientRect().bottom<=innerHeight'));
  await fs.writeFile(${JSON.stringify(path.join(output, 'schedule-700.png'))},(await win.webContents.capturePage()).toPNG());
  await click('提交验证');
  await wait('!!document.querySelector("[aria-label=确认任务已完成]")');
  await click('取消');
  assert.equal(await js('(async()=> (await window.reqflow.getWorkspace()).state.projects[0].items.filter(i=>i.status==="pending_verification").length)()'),0);
  await js('document.querySelector(".gen-actions .primary").click()');
  await wait('!!document.querySelector("[aria-label=确认任务已完成]")');
  await click('确认已完成，提交验证');
  await wait('!document.querySelector("[aria-label=确认任务已完成]")');
  assert.equal(await js('(async()=> (await window.reqflow.getWorkspace()).state.projects[0].items.filter(i=>i.status==="pending_verification").length)()'),30);
  console.log('PASS: 默认/较低高度布局、底部固定操作栏、单条确认取消不写入、批量确认后提交。');
 }catch(e){console.error(e);process.exitCode=1;}finally{win?.destroy();app.quit();}
});`;
  await writeFile(path.join(temp, 'host.cjs'), host);
  await new Promise((resolve, reject) => execFile(path.resolve('node_modules/electron/dist/electron.exe'), [path.join(temp, 'host.cjs')], { windowsHide: true, timeout: 60000 }, (error, stdout, stderr) => { process.stdout.write(stdout); if(error) reject(Error(stderr || error.message)); else resolve(); }));
} finally {
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(temp, { recursive: true, force: true });
}
