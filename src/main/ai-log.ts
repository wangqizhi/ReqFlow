import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AIRequestLog } from '../core/ai';

// 仅保存时间与请求元数据，不保存密钥、URL、需求正文或响应文案。
export class AIRequestLogger {
  private queue: Promise<void> = Promise.resolve();
  private file: string;
  constructor(private dataDir: string) { this.file = path.join(dataDir, 'ai-request-log.json'); }
  append(entry: AIRequestLog) {
    this.queue = this.queue.then(async () => {
      const entries = await this.readFile();
      entries.push(entry);
      await fs.mkdir(this.dataDir, { recursive: true });
      await fs.writeFile(this.file + '.tmp', JSON.stringify(entries.slice(-500)), { mode: 0o600 });
      await fs.rename(this.file + '.tmp', this.file);
    }).catch(() => {}); // 日志写入失败不影响 AI 结果。
  }
  private async readFile(): Promise<AIRequestLog[]> {
    try { const data = JSON.parse(await fs.readFile(this.file, 'utf8')); return Array.isArray(data) ? data.slice(-500) : []; }
    catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
  }
  async read() { await this.queue; return this.readFile(); }
  async flush() { await this.queue; }
}
