#!/usr/bin/env node
// ReqFlow 发布脚本（REQ-073）：升版本号 → 构建 → 打包 Windows 安装包 → 上传 GitHub Release。
//
// 用法：node scripts/publish.mjs [本轮完成的需求条数]
//   版本规则（与交付引导一致）：需求 > 10 条升大版本号，> 5 条升中版本号，其余（含缺省）升小版本号。
//   例：node scripts/publish.mjs 6   →  1.8.4 升至 1.9.0
//
// 依赖：Node >= 22；项目根目录已执行 npm install；GitHub CLI 已通过 gh auth login 登录。
// 打包后自动提交工作区变更、推送当前分支及版本标签，再上传 GitHub Release。
// 产物：安装包与便携版输出到 release/；上传仓库读取 Git origin。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');
const count = Number.parseInt(process.argv[2] || '', 10);
const requirements = Number.isFinite(count) && count > 0 ? count : 0;

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);
const next = requirements > 10 ? [major + 1, 0, 0]
  : requirements > 5 ? [major, minor + 1, 0]
  : [major, minor, patch + 1];
pkg.version = next.join('.');
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
const rule = requirements > 10 ? '升大版本号' : requirements > 5 ? '升中版本号' : '升小版本号';
console.log(`版本号：${pkg.version}（本轮 ${requirements} 条需求，${rule}）`);

const run = (cmd, args) => {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, shell: true });
  if (r.status !== 0) {
    console.error(`步骤失败：${cmd} ${args.join(' ')}（退出码 ${r.status}）`);
    process.exit(1);
  }
};

run('npm', ['run', 'build']);
run('npm', ['run', 'dist']);

const release = path.join(root, 'release');
const artifacts = readdirSync(release).filter((f) => f.includes(pkg.version) && f.endsWith('.exe'));
console.log(`\n打包完成，产物位于 release/（ReqFlow v${pkg.version}）：`);
for (const file of artifacts) console.log('  ' + path.join(release, file));

// 使用参数数组启动 Node，避免 shell 解析带空格的可执行文件或脚本路径。
console.log(`\n上传 GitHub Release（ReqFlow v${pkg.version}）…`);
const upload = spawnSync(process.execPath, [path.join(root, 'scripts', 'release-github.mjs'), '--version', pkg.version], {
  stdio: 'inherit', cwd: root, windowsHide: true,
});
if (upload.error || upload.status !== 0) {
  console.error(`GitHub 上传失败：${upload.error?.message || `退出码 ${upload.status}`}。本地产物已保留；解决问题后可运行 npm run release:github 重试，无需再次升版。`);
  process.exit(1);
}
