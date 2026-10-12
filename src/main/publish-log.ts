import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PublishLogSettings, PublishRequestLog } from '../core/publish-log';

const LIMIT = 2000;
function bound(entries: PublishRequestLog[]) {
  let size = 0;
  return entries.slice(-LIMIT).reverse().filter(entry => {
    size += Buffer.byteLength(JSON.stringify(entry), 'utf8');
    return size <= 512 * 1024;
  }).reverse();
}
function clean(text: string) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(Bearer\s+)\S+/gi, '$1[已隐藏]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s'"&]+/gi, '$1[已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@').slice(0, 4096);
}

export class PublishRequestLogger {
  private file: string;
  private settingsFile: string;
  private settings: PublishLogSettings = { enabled: true };
  private pending: PublishRequestLog[] = [];
  private queue: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  readonly ready: Promise<void>;
  constructor(private dataDir: string) {
    this.file = path.join(dataDir, 'publish-request-log.json');
    this.settingsFile = path.join(dataDir, 'publish-log-settings.json');
    this.ready = fs.readFile(this.settingsFile, 'utf8').then(text => {
      const saved = JSON.parse(text);
      if (typeof saved.enabled === 'boolean') this.settings = { enabled: saved.enabled };
    }).catch(() => {});
  }
  async getSettings() { await this.ready; return { ...this.settings }; }
  async saveSettings(value: PublishLogSettings) {
    if (!value || typeof value.enabled !== 'boolean') throw Error('发布日志设置无效');
    await this.ready;
    const save = this.queue.then(async () => {
      await fs.mkdir(this.dataDir, { recursive: true });
      await fs.writeFile(this.settingsFile + '.tmp', JSON.stringify({ enabled: value.enabled }), { mode: 0o600 });
      await fs.rename(this.settingsFile + '.tmp', this.settingsFile);
      this.settings = { enabled: value.enabled };
    });
    this.queue = save.catch(() => {});
    await save;
  }
  append(entry: PublishRequestLog) {
    if (!this.settings.enabled) return;
    this.pending.push({ ...entry, stage: clean(entry.stage), project: clean(entry.project), script: clean(entry.script), text: entry.text === undefined ? undefined : clean(entry.text) });
    this.pending = this.pending.slice(-LIMIT);
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 250);
  }
  private async readFile(): Promise<PublishRequestLog[]> {
    try { const entries = JSON.parse(await fs.readFile(this.file, 'utf8')); return Array.isArray(entries) ? entries.slice(-LIMIT) : []; }
    catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const batch = this.pending.splice(0);
    if (batch.length) this.queue = this.queue.then(async () => {
      const entries = bound([...await this.readFile(), ...batch]);
      await fs.mkdir(this.dataDir, { recursive: true });
      await fs.writeFile(this.file + '.tmp', JSON.stringify(entries), { mode: 0o600 });
      await fs.rename(this.file + '.tmp', this.file);
    }).catch(() => {}); // 写日志失败不改变发布结果。
    await this.queue;
  }
  async read() { await this.ready; await this.flush(); return this.readFile(); }
}
