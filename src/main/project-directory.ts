import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Only an explicitly supplied absolute directory is touched; never clears existing files. */
export async function prepareProjectDirectory(value: unknown, createMissing: boolean): Promise<string> {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value.trim()) || value.includes('\0')) {
    throw Error('请填写完整的系统目录绝对路径');
  }
  const dir = path.normalize(value.trim());
  let stat;
  try { stat = await fs.stat(dir); }
  catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    if (!createMissing) throw Error('目录不存在，请创建目录或开启「不存在时创建」');
    await fs.mkdir(dir, { recursive: true });
    stat = await fs.stat(dir);
  }
  if (!stat.isDirectory()) throw Error('该路径是文件，不是文件夹');
  await fs.access(dir);
  return fs.realpath(dir);
}
