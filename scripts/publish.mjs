#!/usr/bin/env node
// ReqFlow 发布脚本：预检版本是否已发布 → 构建 → 打包 Windows 安装包 → 上传 GitHub Release。
//
// 用法：node scripts/publish.mjs
//   交付时统一设定 package.json 版本（如 npm version 1.11.1 --no-git-tag-version）。
//   发布和失败重试均使用该版本，不再次升版；自动同步 package-lock.json。
//   构建打包前先查 GitHub：该版本已发布且附件齐全时立即报错退出，不浪费构建时间。
//
// 依赖：Node >= 22；项目根目录已执行 npm install；GitHub CLI 已通过 gh auth login 登录。
// 打包后自动提交工作区变更、推送当前分支及版本标签，再上传 GitHub Release。
// 产物：安装包输出到 release/；上传仓库读取 Git origin。
import { prepareReleaseVersion } from './release-version.mjs';
import { backupPreviousReleases } from './release-backup.mjs';
import { startStep, traceStep } from './release-trace.mjs';
import { checkReleasePublished, releaseNotes } from './release-github.mjs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.length > 2) {
  console.error('发布脚本不再接收需求条数或自动升版，请先在 package.json 中确定交付版本，再直接运行 node scripts/publish.mjs。');
  process.exit(1);
}
const version = prepareReleaseVersion(root);
console.log(`发布版本：${version}（使用当前交付版本，不再次升版）`);
try {
  const notes = await releaseNotes(version);
  console.log(`发布说明已校验：${notes.file}`);
} catch (error) {
  console.error(`发布预检失败：${error.message}`);
  process.exit(1);
}

// 构建前预检：版本已在 GitHub 发布且附件齐全时直接终止；查询失败（未登录、断网）也提前报错。
let released;
try {
  released = traceStep('检查版本是否已发布', () => checkReleasePublished(version));
} catch (error) {
  console.error(`发布预检失败：${error.message}`);
  process.exit(1);
}
if (released.exists && released.complete) {
  console.error(`v${version} 已在 GitHub 发布且附件齐全，无需重复发布：https://github.com/${released.repo}/releases/tag/v${version}`);
  console.error(`如确认要替换附件，运行：npm run release:github -- --version ${version} --clobber`);
  process.exit(1);
}
console.log(released.exists
  ? `GitHub 已有 ${released.tag} 但附件不齐全（缺 ${released.missing.join(', ')}），继续构建打包后补齐上传…`
  : `GitHub 尚未发布 ${released.tag}，继续构建打包…`);

const run = (stage, cmd, args) => {
  const end = startStep(stage);
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, shell: true });
  end(!r.error && r.status === 0);
  if (r.status !== 0) {
    console.error(`步骤失败：${cmd} ${args.join(' ')}（退出码 ${r.status}）`);
    process.exit(1);
  }
};

const archived = traceStep('归档前两个版本产物', () => backupPreviousReleases(root, version));
console.log(`已归档 ${archived.files.length} 个文件到 release/backup（前两个版本：${archived.versions.join(', ') || '无'}）`);

run('构建代码', 'npm', ['run', 'build']);
run('打包 Windows 安装版', 'npm', ['run', 'dist']);

const release = path.join(root, 'release');
const artifacts = [`ReqFlow-Setup-${version}.exe`];
console.log(`\n打包完成，产物位于 release/（ReqFlow v${version}）：`);
for (const file of artifacts) console.log('  ' + path.join(release, file));

// 使用参数数组启动 Node，避免 shell 解析带空格的可执行文件或脚本路径。
console.log(`\n上传 GitHub Release（ReqFlow v${version}）…`);
const upload = spawnSync(process.execPath, [path.join(root, 'scripts', 'release-github.mjs'), '--version', version], {
  stdio: 'inherit', cwd: root, windowsHide: true,
});
if (upload.error || upload.status !== 0) {
  console.error(`GitHub 上传失败：${upload.error?.message || `退出码 ${upload.status}`}。本地产物已保留；解决问题后可运行 npm run release:github 重试，无需再次升版。`);
  process.exit(1);
}
