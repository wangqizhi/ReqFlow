// CLI 模式 —— `ReqFlow.exe --cli <command> [options]`。
// 不打开窗口，直接操作 workspace.json，输出 JSON 到 stdout，退出码 0/1。
// 供脚本与 AI Agent 对接：用子进程管道读取 stdout 即可。

import { promises as fs, writeFileSync } from 'node:fs';
import { CLI_DOCS, CLI_GLOBAL_OPTIONS, CLI_NOTES, CLI_USAGE, renderCliHelpText } from '../core/cli-help';
import { unresolvedFailures } from '../core/domain';
import { WorkspaceService } from '../core/service';
import { WorkspaceStore } from '../core/storage';

export class Cli {
  constructor(
    private argv: string[],
    private appVersion: string,
    private defaultDataDir: string
  ) {}

  async run(): Promise<number> {
    const parsed = this.parse(this.argv);
    if (parsed.help) {
      return this.output(this.helpObject(), parsed);
    }
    const command = parsed._.join(' ');
    try {
      const result = await this.dispatch(command, parsed);
      return this.output({ ok: true, ...result }, parsed);
    } catch (e: any) {
      const payload = { ok: false, error: e?.message || String(e), code: e?.code || 'ERROR' };
      this.writeOut(JSON.stringify(payload), parsed);
      return 1;
    }
  }

  // ---- 参数解析：--key value / --key=value / 位置参数 ----
  private parse(argv: string[]): any {
    const out: any = { _: [] };
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '-h' || a === '--help') {
        out.help = true;
      } else if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
        let value: string = eq === -1 ? '' : a.slice(eq + 1);
        if (eq === -1) {
          const next = argv[i + 1];
          if (next !== undefined && !next.startsWith('--')) {
            value = next;
            i++;
          } else {
            value = 'true';
          }
        }
        out[key] = value;
      } else {
        out._.push(a);
      }
    }
    return out;
  }

  private storeFor(a: any): WorkspaceStore {
    const dir = a['data-dir'] || this.defaultDataDir;
    const { join } = require('node:path') as typeof import('node:path');
    return new WorkspaceStore(join(dir, 'workspace.json'));
  }

  private service(a: any): WorkspaceService {
    return new WorkspaceService(this.storeFor(a));
  }

  private async dispatch(command: string, a: any): Promise<any> {
    switch (command) {
      case 'version':
        return {
          app: 'ReqFlow',
          version: this.appVersion,
          dataFile: this.storeFor(a).filePath,
          protocol: 'workspace-json-v1'
        };
      case 'help':
        return this.helpObject();
      case 'workspace get': {
        const { state, version } = await this.service(a).get();
        return { version, state };
      }
      case 'workspace export': {
        const { state, version } = await this.service(a).get();
        return { version, workspace: state };
      }
      case 'workspace import': {
        if (!a.file) throw new Error('缺少 --file <path>');
        const data = JSON.parse(await fs.readFile(a.file, 'utf8'));
        return await this.service(a).importWorkspace(data, a.replace === true || a.replace === 'true');
      }
      case 'project list': {
        const { state } = await this.service(a).get();
        return {
          projects: state.projects.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            guideVersion: p.guideVersion,
            counts: {
              ready: p.items.filter((i) => !i.archived && i.status === 'ready').length,
              in_progress: p.items.filter((i) => !i.archived && i.status === 'in_progress').length,
              pending_verification: p.items.filter((i) => !i.archived && i.status === 'pending_verification').length,
              archived: p.items.filter((i) => i.archived).length,
              batches: p.batches.length
            }
          }))
        };
      }
      case 'project create': {
        const r = await this.service(a).mutate({ op: 'project', name: a.name, description: a.description || '' }, null);
        const p = r.state.projects[r.state.projects.length - 1];
        return { project: { id: p.id, name: p.name }, version: r.version };
      }
      case 'project delete': {
        const r = await this.service(a).mutate({ op: 'deleteProject', project: a.project }, null);
        return { deleted: a.project, remaining: r.state.projects.length, version: r.version };
      }
      case 'project show': {
        const { state } = await this.service(a).get();
        const p = this.findProject(state, a.project);
        return {
          project: {
            id: p.id, name: p.name, description: p.description, dir: p.dir || '',
            guidance: p.guidance, guideVersion: p.guideVersion,
            deliveryGuidance: p.deliveryGuidance, aiValidation: p.aiValidation,
            nextNumber: p.nextNumber, guideHistoryCount: p.guideHistory.length
          }
        };
      }
      case 'guidance show': {
        const { state } = await this.service(a).get();
        const p = this.findProject(state, a.project);
        return {
          guidance: p.guidance, guideVersion: p.guideVersion,
          deliveryGuidance: p.deliveryGuidance, aiValidation: p.aiValidation,
          guideHistory: p.guideHistory
        };
      }
      case 'guidance set': {
        const action: any = { op: 'guidance', project: a.project, text: a.text };
        if (a.delivery !== undefined) action.deliveryGuidance = a.delivery;
        const bv = this.boolArg(a['ai-validation']);
        if (bv !== undefined) action.aiValidation = bv;
        const r = await this.service(a).mutate(action, null);
        const p = this.findProject(r.state, a.project);
        return { guideVersion: p.guideVersion, version: r.version };
      }
      case 'item add':
      case 'item edit': {
        const action: any = { op: 'item', project: a.project };
        if (command === 'item edit') {
          if (!a.id) throw new Error('缺少 --id <需求ID>');
          action.id = a.id;
        }
        if (a.title !== undefined) action.title = a.title;
        if (a.body !== undefined) action.body = a.body;
        if (a.type !== undefined) action.type = a.type;
        if (a.priority !== undefined) action.priority = a.priority;
        if (a.criteria !== undefined) action.criteria = a.criteria.split(/[;\n]/).map((s: string) => s.trim()).filter(Boolean).join('\n');
        const bv = this.boolArg(a['ai-validation']);
        if (bv !== undefined) action.aiValidation = bv;
        if (a.delivery !== undefined) action.deliveryGuidance = a.delivery;
        if (a.date !== undefined) action.scheduledDate = a.date;
        const r = await this.service(a).mutate(action, null);
        const p = this.findProject(r.state, a.project);
        const item = command === 'item edit' ? p.items.find((i: any) => i.id === a.id) : p.items[p.items.length - 1];
        if (!item) throw new Error('需求不存在');
        return { item: this.itemSummary(item), version: r.version };
      }
      case 'item list': {
        const { state } = await this.service(a).get();
        const status = a.status;
        const search = String(a.search || '').toLowerCase();
        const projects = a.project ? [this.findProject(state, a.project)] : state.projects;
        const items: any[] = [];
        for (const p of projects)
          for (const i of p.items) {
            if (!a.project) items.push({ ...this.itemSummary(i), projectId: p.id, projectName: p.name });
            else items.push(this.itemSummary(i as any));
          }
        const filtered = items.filter((i) => {
          if (status === 'archived') { if (!i.archived) return false; }
          else if (status) { if (i.archived || i.status !== status) return false; }
          else if (i.archived) return false;
          if (search && ![i.number, i.title, i.body].join(' ').toLowerCase().includes(search)) return false;
          return true;
        });
        return { items: filtered, total: filtered.length };
      }
      case 'item show': {
        const { state } = await this.service(a).get();
        const p = this.findProject(state, a.project);
        const i = this.findItem(p, a.id);
        return { item: { ...this.itemSummary(i), history: i.history, flowEvents: i.flowEvents, unresolvedFailures: unresolvedFailures(i) } };
      }
      case 'item history': {
        const { state } = await this.service(a).get();
        const p = this.findProject(state, a.project);
        const i = this.findItem(p, a.id);
        return { history: i.history };
      }
      case 'generate': {
        if (!a.items) throw new Error('缺少 --items <id1,id2,...>');
        const ids = String(a.items).split(',').map((s: string) => s.trim()).filter(Boolean);
        const r = await this.service(a).mutate({ op: 'generate', project: a.project, ids }, null);
        const p = this.findProject(r.state, a.project);
        const b = p.batches[0];
        return {
          batch: this.batchSummary(b),
          prompt: b.text,
          promptLength: b.text.length,
          version: r.version
        };
      }
      case 'batch list': {
        const { state } = await this.service(a).get();
        const p = this.findProject(state, a.project);
        return { batches: p.batches.map((b: any) => this.batchSummary(b)) };
      }
      case 'batch show': {
        const { state } = await this.service(a).get();
        const p = this.findProject(state, a.project);
        const b = p.batches.find((b: any) => b.id === a.id);
        if (!b) throw new Error('批次不存在');
        return { batch: { ...this.batchSummary(b), items: b.items.map((i: any) => this.itemSummary(i)) }, prompt: b.text, hash: b.hash };
      }
      case 'submit':
      case 'cancel': {
        if (!a.batch) throw new Error('缺少 --batch <批次ID>');
        const r = await this.service(a).mutate({ op: command, project: a.project, batch: a.batch }, null);
        return { version: r.version };
      }
      case 'complete': {
        const r = await this.service(a).mutate({ op: 'complete', project: a.project, id: a.id, link: a.link || '', note: a.note || '' }, null);
        return { version: r.version };
      }
      case 'revert': {
        const r = await this.service(a).mutate({ op: 'revert', project: a.project, id: a.id, note: a.note || '' }, null);
        return { version: r.version };
      }
      case 'verify': {
        const pass = this.boolArg(a.pass);
        if (pass === undefined) throw new Error('缺少 --pass <true|false>');
        const r = await this.service(a).mutate({ op: 'verify', project: a.project, id: a.id, pass, note: a.note || '' }, null);
        return { version: r.version };
      }
      case 'regress': {
        const r = await this.service(a).mutate({ op: 'regress', project: a.project, id: a.id, note: a.note || '' }, null);
        return { version: r.version };
      }
      case 'archive': {
        const r = await this.service(a).mutate({ op: 'archive', project: a.project, id: a.id }, null);
        return { version: r.version };
      }
      default:
        throw new Error('未知命令：' + (command || '(空)') + '。运行 --cli help 查看全部命令。');
    }
  }

  // ---- 输出 ----
  private helpObject() {
    return { usage: CLI_USAGE, options: CLI_GLOBAL_OPTIONS, groups: CLI_DOCS, notes: CLI_NOTES, text: renderCliHelpText(this.appVersion) };
  }

  private writeOut(text: string, a: any) {
    try {
      process.stdout.write(text + '\n');
    } catch {
      /* GUI 进程 stdout 可能不可写，忽略 */
    }
    if (a.out) {
      // 同步写：进程可能在写完后立即退出，异步写会被截断
      try {
        writeFileSync(a.out, text + '\n', 'utf8');
      } catch {
        /* 目标路径不可写时忽略，stdout 已有输出 */
      }
    }
  }

  private output(payload: any, a: any): number {
    const text = a.pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
    this.writeOut(text, a);
    return payload.ok === false ? 1 : 0;
  }

  // ---- 工具 ----
  private boolArg(v: any): boolean | undefined {
    if (v === undefined) return undefined;
    if (v === true || v === 'true' || v === '1') return true;
    if (v === false || v === 'false' || v === '0') return false;
    throw new Error('布尔参数无效：' + v + '（应为 true/false）');
  }

  private findProject(state: any, id: string | undefined) {
    if (!id) throw new Error('缺少 --project <项目ID>（可先运行 project list 获取）');
    const p = state.projects.find((p: any) => p.id === id);
    if (!p) throw new Error('项目不存在：' + id);
    return p;
  }

  private findItem(p: any, id: string | undefined) {
    if (!id) throw new Error('缺少 --id <需求ID>');
    const i = p.items.find((i: any) => i.id === id);
    if (!i) throw new Error('需求不存在：' + id);
    return i;
  }

  private itemSummary(i: any) {
    return {
      id: i.id, number: i.number, title: i.title, type: i.type, priority: i.priority,
      status: i.status, archived: !!i.archived, version: i.version,
      executionVersion: i.executionVersion, scheduledDate: i.scheduledDate, aiValidation: i.aiValidation,
      deliveryGuidance: i.deliveryGuidance, link: i.link,
      criteria: i.criteria, bodyPreview: String(i.body || '').slice(0, 120)
    };
  }

  private batchSummary(b: any) {
    return {
      id: b.id, number: b.number, mode: b.mode, status: b.status,
      hash: b.hash, guideVersion: b.guideVersion,
      time: b.time, submittedAt: b.submittedAt || null,
      items: b.items.map((i: any) => ({ id: i.id, number: i.number, title: i.title }))
    };
  }
}
