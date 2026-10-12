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
  await build({ entryPoints: ['src/main/updater.ts'], outfile: path.join(temp, 'updater.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
  await build({ entryPoints: ['src/core/update.ts'], outfile: path.join(temp, 'update.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const host = `
const { app, BrowserWindow, ipcMain, net, shell } = require('electron');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { newerVersion } = require('./update.cjs');
assert.equal(newerVersion('v1.10.6', '1.10.5'), true);
assert.equal(newerVersion('1.9.99', '1.10.5'), false);
assert.equal(newerVersion('1.10.5', '1.10.5'), false);
assert.equal(newerVersion('1.10.6-beta', '1.10.5'), false);
app.setPath('userData', ${JSON.stringify(path.join(temp, 'profile'))});
let bad = true, offline = false, launchFails = true, requestCount = 0, installCount = 0, quits = 0;
app.quit = ()=>{quits++;};
shell.openPath = async file=>{installCount++;assert.equal(file,${JSON.stringify(path.join(temp, 'profile', 'updates', 'ReqFlow-Setup-99.0.0.exe'))});return launchFails ? 'Access denied' : '';};
const bytes = Buffer.from('MZ updater integration fixture');
const digest = createHash('sha256').update(bytes).digest('hex');
net.fetch = async url => {
 if(offline) throw TypeError('fetch failed');
 if(String(url).endsWith('/releases/latest')) return new Response(JSON.stringify({tag_name:'v99.0.0', assets:[{name:'ReqFlow-Setup-99.0.0.exe',size:bytes.length,digest:'sha256:'+digest,browser_download_url:'https://github.com/wangqizhi/ReqFlow/releases/download/v99.0.0/ReqFlow-Setup-99.0.0.exe'}]}));
 requestCount++;
 const payload = bad ? Buffer.alloc(bytes.length, 1) : bytes;
 return new Response(new ReadableStream({start(controller){controller.enqueue(payload.subarray(0,10));setTimeout(()=>{controller.enqueue(payload.subarray(10));controller.close();},1200);}}));
};
global.fetch = ()=>{throw Error('Updater must use Electron net.fetch');};
app.whenReady().then(async()=>{
 let win;
 try {
  require('./ipc.cjs').registerIpc(${JSON.stringify(path.join(temp, 'data'))});
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
  await wait('document.querySelector(".update-error")?.textContent.includes("Access denied")');
  assert.equal(installCount,1);
  assert.equal(quits,0);
  await fs.rm(${JSON.stringify(path.join(temp, 'profile', 'updates', 'downloaded.json'))});
  for(const channel of ['update:state','update:check','update:download','update:install']) ipcMain.removeHandler(channel);
  require('./updater.cjs').registerUpdater();
  assert.equal(await js('(async()=> (await window.reqflow.checkUpdate()).phase)()'),'ready');
  assert.equal(requestCount,2);
  // Register a fresh updater as after a restart: retain only the downloaded disk cache.
  for(const channel of ['update:state','update:check','update:download','update:install']) ipcMain.removeHandler(channel);
  require('./updater.cjs').registerUpdater();
  offline = true;
  assert.equal(await js('(async()=> (await window.reqflow.checkUpdate()).phase)()'),'ready');
  assert.equal(requestCount,2);
  launchFails = false;
  await wait('!document.querySelector(".update-button").disabled');
  await click();
  await wait('document.querySelector(".update-button").textContent.includes("启动安装")');
  await new Promise(r=>setTimeout(r,500));
  assert.equal(installCount,2);
  assert.equal(quits,1);
  // Recheck integrity at installation time, even if the cache was valid earlier.
  for(const channel of ['update:state','update:check','update:download','update:install']) ipcMain.removeHandler(channel);
  require('./updater.cjs').registerUpdater();
  assert.equal(await js('(async()=> (await window.reqflow.checkUpdate()).phase)()'),'ready');
  await fs.writeFile(${JSON.stringify(path.join(temp, 'profile', 'updates', 'ReqFlow-Setup-99.0.0.exe'))},Buffer.alloc(bytes.length,0));
  assert.equal(await js('(async()=> (await window.reqflow.installUpdate()).phase)()'),'error');
  assert.equal(installCount,2);
  assert.equal(quits,1);
  const failure = await js('window.reqflow.downloadUpdate()');
  assert.equal(failure.retry,'download');
  assert.match(failure.error,/连接 GitHub 失败/);
  console.log('PASS: 版本比较、下载进度、防重复、校验失败重试、离线重启恢复缓存、真实安装处理的启动失败不退出/成功才退出、安装前再次校验、1440x900/700 布局。');
 }catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode || 0);}
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
