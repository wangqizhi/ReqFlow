import { existsSync, readdirSync, mkdirSync, lstatSync, realpathSync, linkSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z0-9.-]+))?$/;
function compareVersions(a, b) {
  const x = a.match(versionPattern), y = b.match(versionPattern);
  for (let i = 1; i <= 3; i++) {
    const delta = Number(x[i]) - Number(y[i]);
    if (delta) return delta;
  }
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  const left = x[4].split('.'), right = y[4].split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === undefined) return -1;
    if (right[i] === undefined) return 1;
    if (left[i] === right[i]) continue;
    const ln = /^\d+$/.test(left[i]), rn = /^\d+$/.test(right[i]);
    if (ln && rn) return Number(left[i]) - Number(right[i]);
    if (ln !== rn) return ln ? -1 : 1;
    return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

function artifactVersion(name) {
  const match = name.match(/^(?:ReqFlow-(?:Setup|Portable)-(.+)\.exe(?:\.blockmap)?|(?:SHA256SUMS|README-Portable)-(.+)\.txt|packaging-manifest-(.+)\.json)$/);
  const version = match && (match[1] || match[2] || match[3]);
  return version && versionPattern.test(version) ? version : null;
}

// Archive the two releases immediately preceding current. Include already archived
// versions when selecting them so a retry never starts moving older releases.
export function backupPreviousReleases(root, current) {
  if (!versionPattern.test(current)) throw Error('归档版本格式无效');
  const release = path.resolve(root, 'release');
  if (!existsSync(release)) return { versions: [], files: [] };
  const assertDirectory = directory => {
    if (lstatSync(directory).isSymbolicLink() || realpathSync(directory).toLowerCase() !== directory.toLowerCase()) {
      throw Error(`发布归档目录不能是链接：${directory}`);
    }
  };
  assertDirectory(release);
  const backup = path.join(release, 'backup');
  if (existsSync(backup)) assertDirectory(backup);
  const files = readdirSync(release, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => ({ name: entry.name, version: artifactVersion(entry.name) }))
    .filter(entry => entry.version);
  const versions = new Set(files.map(entry => entry.version));
  if (existsSync(backup)) {
    for (const entry of readdirSync(backup, { withFileTypes: true })) {
      if (entry.isDirectory() && versionPattern.test(entry.name)) versions.add(entry.name);
      const version = entry.isFile() && artifactVersion(entry.name);
      if (version) versions.add(version);
    }
  }
  const selected = [...versions].filter(version => compareVersions(version, current) < 0)
    .sort((a, b) => compareVersions(b, a)).slice(0, 2);
  const moves = files.filter(entry => selected.includes(entry.version)).map(entry => ({
    source: path.join(release, entry.name),
    directory: path.join(backup, entry.version),
    destination: path.join(backup, entry.version, entry.name),
  }));
  // Check all destinations before moving any file. Never overwrite prior backups.
  for (const move of moves) {
    if (existsSync(move.directory)) assertDirectory(move.directory);
    if (existsSync(move.destination)) throw Error(`备份文件已存在，请先处理重名文件：${move.destination}`);
  }
  for (const move of moves) {
    mkdirSync(move.directory, { recursive: true });
    assertDirectory(move.directory);
    // Same-volume hard link + unlink provides a move without rename's overwrite.
    linkSync(move.source, move.destination);
    unlinkSync(move.source);
  }
  return { versions: selected, files: moves.map(move => move.destination) };
}
