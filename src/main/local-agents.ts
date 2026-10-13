import { ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
const definitions = [{ id: 'opencode', name: 'OpenCode', command: 'opencode', package: 'opencode-ai' }, { id: 'pi', name: 'pi', command: 'pi', package: '@earendil-works/pi-coding-agent' }];
const validId = (id: string) => id === 'codex' || id === 'zcode' || definitions.some(d => d.id === id);
export function version(command: string): Promise<{ installed: boolean; version?: string; error?: string }> {
  return new Promise(resolve => {
    // Only fixed, built-in commands are executed; user input never enters the shell.
    const windows = process.platform === 'win32';
    execFile(windows ? 'cmd.exe' : command, windows ? ['/d', '/s', '/c', `${command} --version`] : ['--version'], { windowsHide: true, timeout: 8000, maxBuffer: 16384 }, (error, stdout) => {
      const value = stdout.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/)?.[0];
      resolve(error ? { installed: false, error: '未找到可用命令，或版本检测失败/超时' } : { installed: true, version: value, error: value ? undefined : '命令可用，但无法识别版本' });
    });
  });
}
export function registerLocalAgents(dataDir: string) {
  const file = path.join(dataDir, 'local-agents.json');
  async function read(): Promise<string[]> {
    try { const value = JSON.parse(await fs.readFile(file, 'utf8')); return Array.isArray(value) ? value.filter(validId) : []; }
    catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
  }
  ipcMain.handle('agents:get', async () => { try { return { ok: true, enabled: await read() }; } catch { return { ok: false, error: '读取 Agent 配置失败' }; } });
  ipcMain.handle('agents:save', async (_e, enabled: unknown) => {
    try {
      if (!Array.isArray(enabled) || enabled.some(id => !validId(id))) throw Error('Agent 配置无效');
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(file + '.tmp', JSON.stringify([...new Set(enabled)]), 'utf8'); await fs.rename(file + '.tmp', file);
      return { ok: true };
    } catch (e: any) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('agents:detect', async () => ({ ok: true, agents: await Promise.all(definitions.map(async d => {
    const local = await version(d.command);
    let latest: string | undefined, update: boolean | undefined, registryError: string | undefined;
    try {
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(d.package)}/latest`, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw Error();
      latest = (await response.json() as any).version;
      if (local.version && latest && /^\d+\.\d+\.\d+$/.test(local.version) && /^\d+\.\d+\.\d+$/.test(latest)) {
        const a = local.version.split('.').map(Number), b = latest.split('.').map(Number);
        const index = a.findIndex((v, i) => v !== b[i]); update = index >= 0 && b[index] > a[index];
      }
    } catch { registryError = '无法获取最新版本，请稍后重试'; }
    return { ...d, ...local, latest, update, registryError };
  })) }));
}
