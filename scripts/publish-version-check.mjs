import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { prepareReleaseVersion, verifyReleaseVersion } from './release-version.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'reqflow publish-version-'));
try {
  const scripts = path.join(temp, 'scripts');
  const bin = path.join(temp, 'bin');
  await mkdir(scripts);
  await mkdir(bin);
  await writeFile(path.join(temp, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.11.1' }));
  await writeFile(path.join(temp, 'package-lock.json'), JSON.stringify({ version: '1.10.8', packages: { '': { version: '1.10.8' }, 'node_modules/example': { version: '2.0.0' } } }));
  assert.equal(prepareReleaseVersion(temp), '1.11.1');
  const lock = JSON.parse(await readFile(path.join(temp, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, '1.11.1');
  assert.equal(lock.packages[''].version, '1.11.1');
  assert.equal(lock.packages['node_modules/example'].version, '2.0.0');
  await assert.rejects(verifyReleaseVersion(temp, '1.11.2'), /不一致/);
  await assert.rejects(verifyReleaseVersion(temp, '1.11.1'), /缺少打包应用/);
  for (const name of ['publish.mjs', 'release-version.mjs']) await copyFile(path.resolve('scripts', name), path.join(scripts, name));
  const fakeNpm = path.join(bin, 'npm-fixture.cjs');
  await writeFile(fakeNpm, `const fs=require('node:fs');const path=require('node:path');const version=JSON.parse(fs.readFileSync('package.json')).version;const step=process.argv[3];fs.appendFileSync('steps.txt',step+':'+version+'\\n');if(step==='dist'){fs.mkdirSync('release',{recursive:true});for(const kind of ['Setup','Portable'])fs.writeFileSync(path.join('release','ReqFlow-'+kind+'-'+version+'.exe'),'MZ fixture');}`);
  await writeFile(path.join(bin, 'npm.cmd'), `@"${process.execPath}" "${fakeNpm}" %*\r\n`);
  await writeFile(path.join(scripts, 'release-github.mjs'), `import fs from 'node:fs';const version=process.argv[process.argv.indexOf('--version')+1];if(version!==JSON.parse(fs.readFileSync('package.json')).version)process.exit(2);fs.appendFileSync('steps.txt','upload:'+version+'\\n');if(process.env.REQFLOW_FIXTURE_FAIL==='1')process.exit(1);`);
  const invoke = (failure) => spawnSync(process.execPath, [path.join(scripts, 'publish.mjs')], { cwd: temp, encoding: 'utf8', windowsHide: true, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, REQFLOW_FIXTURE_FAIL: failure ? '1' : '0' } });
  const failed = invoke(true);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /GitHub 上传失败/);
  assert.equal(JSON.parse(await readFile(path.join(temp, 'package.json'))).version, '1.11.1');
  const retry = invoke(false);
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.equal(JSON.parse(await readFile(path.join(temp, 'package.json'))).version, '1.11.1');
  const steps = (await readFile(path.join(temp, 'steps.txt'), 'utf8')).trim().split('\n');
  assert.deepEqual(steps, ['build:1.11.1', 'dist:1.11.1', 'upload:1.11.1', 'build:1.11.1', 'dist:1.11.1', 'upload:1.11.1']);
  console.log('PASS: 锁文件同步、依赖版本保留、版本不一致/未打包时拒绝发布、真实 publish 脚本首次上传失败及重试均保持 1.11.1（构建/上传使用本地替代程序，未访问 GitHub）。');
} finally {
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(temp, { recursive: true, force: true });
}
