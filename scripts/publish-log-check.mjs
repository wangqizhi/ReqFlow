import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const temp = await mkdtemp(path.join(os.tmpdir(), 'reqflow-publish-log-'));
const output = path.resolve('out/publish-log-review');
try {
  await mkdir(output, { recursive: true });
  await build({ entryPoints: ['src/main/ipc.ts'], outfile: path.join(temp, 'ipc.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
  await build({ entryPoints: ['src/main/publish-log.ts'], outfile: path.join(temp, 'logger.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { PublishRequestLogger } = await import(pathToFileURL(path.join(temp, 'logger.mjs')).href);
  const loggerData = path.join(temp, 'logger-data');
  const logger = new PublishRequestLogger(loggerData);
  assert.deepEqual(await logger.getSettings(), { enabled: true });
  const record = { requestId: 'test', project: 'fixture', script: 'publish.mjs', stage: '上传', phase: 'output', time: new Date().toISOString(), elapsedMs: 0 };
  logger.append({ ...record, text: '\x1b[31msecret=TEST_SECRET Bearer TOKEN_VALUE https://user:password@example.com/path\x1b[0m' });
  await logger.flush();
  let entries = await logger.read();
  assert.ok(!JSON.stringify(entries).includes('TEST_SECRET'));
  assert.ok(!JSON.stringify(entries).includes('TOKEN_VALUE'));
  assert.ok(!JSON.stringify(entries).includes('user:password'));
  await logger.saveSettings({ enabled: false });
  logger.append({ ...record, text: 'should not be logged' });
  assert.equal((await logger.read()).length, entries.length);
  const reopened = new PublishRequestLogger(loggerData);
  assert.deepEqual(await reopened.getSettings(), { enabled: false });
  await reopened.saveSettings({ enabled: true });
  for (let i = 0; i < 2300; i++) reopened.append({ ...record, text: String(i) });
  assert.equal((await reopened.read()).length, 2000);
  for (let i = 0; i < 300; i++) reopened.append({ ...record, text: '长'.repeat(4000) });
  await reopened.flush();
  assert.ok((await readFile(path.join(loggerData, 'publish-request-log.json'))).length < 520 * 1024);

  const project = path.join(temp, 'project');
  await mkdir(project);
  const script = path.join(project, 'publish.mjs');
  await writeFile(script, `console.log('@@REQFLOW_PUBLISH '+JSON.stringify({stage:'构建代码',phase:'start'}));console.log('secret=LOG_TEST_SECRET');console.log('@@REQFLOW_PUBLISH '+JSON.stringify({stage:'构建代码',phase:'complete',elapsedMs:120}));console.log('@@REQFLOW_PUBLISH '+JSON.stringify({stage:'上传安装包到 GitHub',phase:'start'}));await new Promise(r=>setTimeout(r,6500));console.error('附件上传输出');console.log('@@REQFLOW_PUBLISH '+JSON.stringify({stage:'上传安装包到 GitHub',phase:'complete',elapsedMs:6500}));`);
  const host = `
const { app, BrowserWindow, net } = require('electron');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
app.setPath('userData',${JSON.stringify(path.join(temp, 'profile'))});
net.fetch = async()=>new Response(JSON.stringify({tag_name:'v'+app.getVersion(),assets:[]}));
app.whenReady().then(async()=>{
 let win;
 try {
  require('./ipc.cjs').registerIpc(${JSON.stringify(path.join(temp, 'data'))});
  win = new BrowserWindow({width:1440,height:900,show:false,webPreferences:{preload:${JSON.stringify(path.resolve('dist/preload/index.js'))},sandbox:false,backgroundThrottling:false}});
  await win.loadFile(${JSON.stringify(path.resolve('dist/renderer/index.html'))});
  await win.webContents.insertCSS('*{transition:none!important;animation:none!important}');
  const js = source=>win.webContents.executeJavaScript(source);
  const wait = async source=>{for(let i=0;i<220;i++){if(await js(source))return;await new Promise(r=>setTimeout(r,50));}throw Error('UI timeout: '+source);};
  const click = text=>js('Array.from(document.querySelectorAll("button")).find(button=>button.textContent.trim()==='+JSON.stringify(text)+').click()');
  await wait('!!document.querySelector(".side-foot")');
  await click('设置');await click('请求日志');
  await wait('!document.querySelector("#publish-request-logging").disabled');
  assert.equal(await js('document.querySelector("#publish-request-logging").checked'),true);
  await click('发布请求');
  await js('window.testPublishDone=false;window.testPublishResult=null;void window.reqflow.runPublish('+${JSON.stringify(JSON.stringify(project))}+', "publish.mjs").then(result=>{window.testPublishResult=result;window.testPublishDone=true;});');
  await wait('document.querySelector(".publish-log-terminal").textContent.includes("上传安装包到 GitHub")');
  assert.equal(await js('window.testPublishDone'),false,'日志应在发布结束前可查看');
  assert.equal(await js('document.querySelector(".publish-log-terminal").textContent.includes("LOG_TEST_SECRET")'),false);
  await wait('window.testPublishDone');
  assert.equal(await js('window.testPublishResult.ok'),true);
  const entries = (await js('window.reqflow.getPublishRequestLogs()')).entries;
  assert.ok(entries.some(entry=>entry.phase==='stage_complete' && entry.durationMs===6500));
  assert.ok(entries.some(entry=>entry.phase==='progress' && entry.stage==='上传安装包到 GitHub'));
  assert.ok(entries.some(entry=>entry.phase==='complete'));
  assert.ok(entries.some(entry=>entry.text==='附件上传输出'));
  await wait('document.querySelector(".publish-log-terminal").textContent.includes("发布成功")');
  win.setSize(1440,700);await new Promise(r=>setTimeout(r,350));
  const layout = await js('(()=>{const dialog=document.querySelector(".settings-dialog").getBoundingClientRect();const footer=document.querySelector(".settings-footer").getBoundingClientRect();return {dialog:dialog.toJSON(),footer:footer.toJSON(),height:innerHeight};})()');
  assert.ok(layout.dialog.bottom<=layout.height && layout.footer.bottom<=layout.height,JSON.stringify(layout));
  await fs.writeFile(${JSON.stringify(path.join(output, 'logs-700.png'))},(await win.webContents.capturePage()).toPNG());
  await js('document.querySelector("#publish-request-logging").click()');await click('保存日志设置');
  await wait('document.querySelector(".settings-message")?.textContent==="日志设置已保存"');
  const count = (await js('window.reqflow.getPublishRequestLogs()')).entries.length;
  await js('window.reqflow.runPublish('+${JSON.stringify(JSON.stringify(project))}+', "publish.mjs")');
  assert.equal((await js('window.reqflow.getPublishRequestLogs()')).entries.length,count);
  await js('window.reqflow.savePublishLogSettings({enabled:true})');
  await fs.writeFile(${JSON.stringify(script)},'console.error("fixture failure");process.exit(7);');
  assert.equal((await js('window.reqflow.runPublish('+${JSON.stringify(JSON.stringify(project))}+', "publish.mjs")')).ok,false);
  assert.ok((await js('window.reqflow.getPublishRequestLogs()')).entries.some(entry=>entry.phase==='error' && entry.text==='fixture failure'));
  console.log('PASS: 发布日志默认开启、请求日志入口/开关保存、执行结束前刷新、阶段与累计耗时、心跳、stdout/stderr、成功/失败、关闭不新增、低高度布局；未访问 GitHub 或实际发布。');
 }catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}
});`;
  await writeFile(path.join(temp, 'host.cjs'), host);
  await new Promise((resolve, reject) => execFile(path.resolve('node_modules/electron/dist/electron.exe'), [path.join(temp, 'host.cjs')], { windowsHide: true, timeout: 60000 }, (error, stdout, stderr) => {
    process.stdout.write(stdout);
    if (error) reject(Error(stderr || error.message)); else resolve();
  }));
  console.log('PASS: 日志独立持久化、重启恢复开关、常见密钥隐藏、2000 条及约 512KB 保留上限。');
} finally {
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(temp, { recursive: true, force: true });
}
