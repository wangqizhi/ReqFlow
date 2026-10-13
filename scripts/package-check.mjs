import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { extractFile } from '@electron/asar';
import { setTimeout as delay } from 'node:timers/promises';
const archive = path.resolve('release/win-unpacked/resources/app.asar');
const version = JSON.parse(fs.readFileSync('package.json','utf8')).version;
assert.equal(JSON.parse(extractFile(archive,'package.json')).version, version);
for (const file of ['dist/main/index.js','dist/preload/index.js','dist/renderer/index.html',...fs.readdirSync('dist/renderer/assets').map((f)=>'dist/renderer/assets/'+f)])
  assert.ok(fs.readFileSync(file).equals(extractFile(archive,path.normalize(file))),file+' matches final build');
const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'reqflow-package-'));
try {
  const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  for(const exe of ['release/win-unpacked/ReqFlow.exe',`release/ReqFlow-Portable-${version}.exe`]) {
    const resultFile=path.join(dataDir, 'version.json');
    fs.rmSync(resultFile,{force:true});
    execFileSync(path.resolve(exe),['--cli','version','--data-dir',dataDir,'--out',resultFile],{encoding:'utf8',windowsHide:true,timeout:60000,env});
    for(let n=0;n<100 && !fs.existsSync(resultFile);n++) await delay(100);
    const parsed=JSON.parse(fs.readFileSync(resultFile,'utf8')); assert.equal(parsed.version,version); assert.equal(parsed.ok,true);
    console.log('PASS packaged CLI: '+exe+' version '+parsed.version+' exit=0');
    const workspaceResult=path.join(dataDir,'workspace-result.json');
    fs.rmSync(workspaceResult,{force:true});
    execFileSync(path.resolve(exe),['--cli','workspace','get','--data-dir',dataDir,'--out',workspaceResult],{encoding:'utf8',windowsHide:true,timeout:60000,env});
    for(let n=0;n<100 && !fs.existsSync(workspaceResult);n++) await delay(100);
    const workspace=JSON.parse(fs.readFileSync(workspaceResult,'utf8'));
    assert.equal(workspace.ok,true); assert.equal(workspace.state.projects.length,1);
    assert.ok(fs.existsSync(path.join(dataDir,'requirements.sqlite')),'packaged SQLite is operational');
    console.log('PASS packaged SQLite workspace: '+exe);
  }
} finally { fs.rmSync(dataDir,{recursive:true,force:true}); }
for(const file of [`release/ReqFlow-Setup-${version}.exe`,`release/ReqFlow-Portable-${version}.exe`])
  assert.equal(fs.readFileSync(file).subarray(0,2).toString(),'MZ');
console.log('PASS installer and portable PE, all ASAR files match final build');
