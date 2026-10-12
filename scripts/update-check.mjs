import { build } from 'esbuild';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const temp = await mkdtemp(path.join(os.tmpdir(), 'reqflow-update-check-'));
const output = path.resolve('out/update-review');
try {
  await mkdir(output, { recursive: true });
  await build({ entryPoints: ['src/main/ipc.ts'], outfile: path.join(temp, 'ipc.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
  await build({ entryPoints: ['src/core/update.ts'], outfile: path.join(temp, 'update.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const host = `
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { newerVersion } = require('./update.cjs');
assert.equal(newerVersion('v1.10.6', '1.10.5'), true);
assert.equal(newerVersion('1.9.99', '1.10.5'), false);
assert.equal(newerVersion('1.10.5', '1.10.5'), false);
assert.equal(newerVersion('1.10.6-beta', '1.10.5'), false);
app.setPath('userData', ${JSON.stringify(path.join(temp, 'profile'))});
let bad = true, requestCount = 0, installCount = 0;
const bytes = Buffer.from('MZ updater integration fixture');
const digest = createHash('sha256').update(bytes).digest('hex');
global.fetch = async url => {
 if(String(url).endsWith('/releases/latest')) return new Response(JSON.stringify({tag_name:'v99.0.0', assets:[{name:'ReqFlow-Setup-99.0.0.exe',size:bytes.length,digest:'sha256:'+digest,browser_download_url:'https://github.com/wangqizhi/ReqFlow/releases/download/v99.0.0/ReqFlow-Setup-99.0.0.exe'}]}));
 requestCount++;
 const payload = bad ? Buffer.alloc(bytes.length, 1) : bytes;
 return new Response(new ReadableStream({start(controller){controller.enqueue(payload.subarray(0,10));setTimeout(()=>{controller.enqueue(payload.subarray(10));controller.close();},1200);}}));
};
app.whenReady().then(async()=>{
 let win;
 try {
  require('./ipc.cjs').registerIpc(${JSON.stringify(path.join(temp, 'data'))});
  // Exercise the install button without launching an installer or quitting the test host.
  ipcMain.removeHandler('update:install');
  ipcMain.handle('update:install',()=>{installCount++;return {phase:'installing',version:'99.0.0'};});
  win = new BrowserWindow({width:1440,height:900,show:false,webPreferences:{preload:${JSON.stringify(path.resolve('dist/preload/index.js'))},sandbox:false,backgroundThrottling:false}});
  await win.loadFile(${JSON.stringify(path.resolve('dist/renderer/index.html'))});
  const js = source=>win.webContents.executeJavaScript(source);
  const wait = async source=>{for(let i=0;i<160;i++){if(await js(source))return;await new Promise(r=>setTimeout(r,50));}throw Error('UI timeout: '+source);};
  const click = ()=>js('document.querySelector(".update-button").click()');
  await wait('document.querySelector(".update-button")?.textContent.includes("更新")');
  assert.equal(await js('document.querySelector(".update-button").classList.contains("danger")'),true);
  await fs.writeFile(${JSON.stringify(path.join(output, 'available-1440.png'))},(await win.webContents.capturePage()).toPNG());
  await click();
  await wait('!!document.querySelector(".update-control progress")');
  assert.equal(await js('document.querySelector(".update-button").disabled'),true);
  await js('window.reqflow.downloadUpdate()');
  assert.equal(requestCount,1);
  await wait('!!document.querySelector(".update-error")');
  assert.match(await js('document.querySelector(".update-error").textContent'),/校验失败/);
  await assert.rejects(fs.stat(${JSON.stringify(path.join(temp, 'profile', 'updates', 'ReqFlow-Setup-99.0.0.exe.part'))}));
  bad = false;
  await click();
  await wait('document.querySelector(".update-button").textContent.includes("更新")');
  await click();
  await wait('document.querySelector(".update-button").textContent.includes("下载")');
  await fs.writeFile(${JSON.stringify(path.join(output, 'downloading-1440.png'))},(await win.webContents.capturePage()).toPNG());
  await wait('document.querySelector(".update-button").textContent.trim()==="安装"');
  await wait('!document.querySelector(".update-button").disabled');
  assert.equal(await js('document.querySelector(".update-button").classList.contains("danger")'),true);
  assert.deepEqual(await fs.readFile(${JSON.stringify(path.join(temp, 'profile', 'updates', 'ReqFlow-Setup-99.0.0.exe'))}),bytes);
  for(const height of [900,700]){
   win.setSize(1440,height);
   await new Promise(r=>setTimeout(r,350));
   assert.equal(await js('(()=>{const row=document.querySelector(".side-help-update");const [help,control]=row.children;const h=help.getBoundingClientRect(),u=control.getBoundingClientRect();return Math.abs(h.top-u.top)<2 && u.right<=row.getBoundingClientRect().right && u.bottom<=innerHeight;})()'),true);
   await fs.writeFile(${JSON.stringify(path.join(output, 'ready-'))} + height + '.png',(await win.webContents.capturePage()).toPNG());
  }
  assert.equal(installCount,0);
  await click();
  await wait('document.querySelector(".update-button").textContent.includes("启动安装")');
  assert.equal(installCount,1);
  console.log('PASS: 版本比较、自动检测、红色更新/安装、下载进度、防重复下载、校验失败清理及重试、用户点击安装、1440x900/700 侧栏布局。');
 }catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();app.quit();}
});`;
  await writeFile(path.join(temp, 'host.cjs'), host);
  await new Promise((resolve, reject) => execFile(path.resolve('node_modules/electron/dist/electron.exe'), [path.join(temp, 'host.cjs')], { windowsHide: true, timeout: 60000 }, (error, stdout, stderr) => {
    process.stdout.write(stdout);
    if (error) reject(Error(stderr || error.message)); else resolve();
  }));
} finally {
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(temp, { recursive: true, force: true });
}
