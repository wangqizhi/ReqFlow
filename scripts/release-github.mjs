// 上传指定版本产物前，自动提交工作区并推送分支及版本标签。
import { releaseRepository, prepareReleaseGit } from './release-git.mjs';
import { verifyReleaseVersion } from './release-version.mjs';
import { traceStep } from './release-trace.mjs';
import { readFile, writeFile, stat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const help = `用法：npm run release:github -- [选项]
  --dry-run          检查产物并预览，不访问 GitHub、不写文件
  --version <版本>  默认读取 package.json，必须与源码及打包内部版本一致
  --repo <仓库>     默认读取 Git origin（须与 origin 一致）
  --notes <文件>    发布说明；默认 docs/release-<版本>.md（存在时）
  --draft           新建为草稿（已有 Release 保持其发布状态）
  --clobber         允许替换已有同名附件
  --help            显示帮助
发布前：构建打包，并运行 gh auth login。
上传时自动提交当前工作区变更，推送当前分支及 v<版本> 标签；不会强制推送或覆盖标签。`;

function gh(args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync('gh', args, { cwd: root, encoding: 'utf8', windowsHide: true,
    stdio: capture ? 'pipe' : 'inherit' });
  if (result.error) throw Error(`无法执行 GitHub CLI：${result.error.message}`);
  if (result.status !== 0 && !allowFailure) throw Error(`gh ${args.slice(0, 2).join(' ')} 失败${capture ? `：${result.stderr.trim()}` : ''}`);
  return result;
}

async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function main() {
  const options = {};
  const boolean = new Set(['dry-run', 'draft', 'clobber', 'help']);
  const valued = new Set(['version', 'repo', 'notes']);
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (args[i] !== `--${key}` || (!boolean.has(key) && !valued.has(key))) throw Error(`未知参数：${args[i]}`);
    if (boolean.has(key)) options[key] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`--${key} 缺少值`);
      options[key] = args[++i];
    }
  }
  if (options.help) { console.log(help); return; }
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const version = options.version || pkg.version;
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw Error('版本格式应为 x.y.z 或 x.y.z-预发布版本');
  const originRepo = releaseRepository();
  const repo = options.repo || originRepo;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw Error('仓库格式应为 owner/repo');
  if (repo.toLowerCase() !== originRepo.toLowerCase()) throw Error('--repo 必须与 Git origin 仓库一致，以确保标签与源码匹配');
  const tag = `v${version}`;
  const names = [`ReqFlow-Setup-${version}.exe`, `ReqFlow-Portable-${version}.exe`];
  const assets = names.map(name => path.join(root, 'release', name));
  for (const file of assets) {
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size === 0) throw Error(`缺少有效产物：${path.basename(file)}。请先 npm run build，再 npm run dist；不会上传其他版本。`);
    const handle = await open(file, 'r');
    try {
      const magic = Buffer.alloc(2);
      await handle.read(magic, 0, 2, 0);
      if (magic.toString() !== 'MZ') throw Error(`产物不是 Windows 可执行文件：${path.basename(file)}`);
    } finally { await handle.close(); }
  }
  await traceStep('检查发布版本一致性', () => verifyReleaseVersion(root, version));
  console.log(`版本一致性检查通过：源码、锁文件、打包应用、安装版、便携版均为 ${version}`);
  const sums = (await traceStep('计算安装包 SHA256', () => Promise.all(assets.map(async (file, i) => `${await hash(file)}  ${names[i]}`)))).join('\n') + '\n';
  const sumsFile = path.join(root, 'release', `SHA256SUMS-${version}.txt`);
  let notesFile = options.notes ? path.resolve(root, options.notes) : path.join(root, 'docs', `release-${version}.md`);
  const notesInfo = await stat(notesFile).catch(() => null);
  if (options.notes && !notesInfo?.isFile()) throw Error('发布说明文件不存在');
  if (!notesInfo?.isFile()) notesFile = null;
  console.log(`目标：https://github.com/${repo}/releases/tag/${tag}`);
  console.log(`附件：${[...names, path.basename(sumsFile)].join(', ')}`);
  console.log(`说明：${notesFile || '默认安装说明'}；新建状态：${options.draft ? '草稿' : '公开发布'}`);
  if (options['dry-run']) { console.log(sums.trim()); console.log('预览完成；未上传。'); return; }
  traceStep('检查 GitHub 登录', () => gh(['auth', 'status', '--hostname', 'github.com'], { capture: true }));
  prepareReleaseGit(version);
  // --verify-tag 阻止 gh 默认在远程默认分支上自动创建一个可能不匹配产物的标签。
  traceStep('检查远程版本标签', () => gh(['api', `repos/${repo}/git/ref/tags/${tag}`], { capture: true }));
  const existing = traceStep('查询 GitHub Release', () => gh(['release', 'view', tag, '--repo', repo, '--json', 'tagName,assets'], { capture: true, allowFailure: true }));
  if (existing.status !== 0 && !/release not found/i.test(existing.stderr)) throw Error(`无法查询 Release：${existing.stderr.trim()}`);
  if (existing.status === 0 && !options.clobber) {
    const remoteNames = new Set(JSON.parse(existing.stdout).assets.map(asset => asset.name));
    const conflicts = [...names, path.basename(sumsFile)].filter(name => remoteNames.has(name));
    if (conflicts.length) throw Error(`附件已存在：${conflicts.join(', ')}。确认需要替换后使用 --clobber。`);
  }
  await writeFile(sumsFile, sums, 'utf8');
  if (existing.status === 0) {
    traceStep('上传安装包到 GitHub', () => gh(['release', 'upload', tag, ...assets, sumsFile, '--repo', repo, ...(options.clobber ? ['--clobber'] : [])]));
  } else {
    traceStep('创建 Release 并上传安装包到 GitHub', () => gh(['release', 'create', tag, ...assets, sumsFile, '--repo', repo, '--verify-tag', '--title', `ReqFlow ${version}`,
      ...(notesFile ? ['--notes-file', notesFile] : ['--notes', `ReqFlow ${version}\n\nWindows x64：Setup 为安装版，Portable 为便携版。下载后可用 SHA256SUMS 文件校验。`]),
      ...(options.draft ? ['--draft'] : []), ...(version.includes('-') ? ['--prerelease'] : [])]));
  }
  console.log(`完成：https://github.com/${repo}/releases/tag/${tag}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
