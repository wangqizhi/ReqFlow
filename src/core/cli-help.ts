// CLI 参考说明 —— 单一数据源：
//  1) `ReqFlow.exe --cli help` 的文本输出（构建生成 Go 后端帮助常量）
//  2) GUI 帮助页面的命令表（renderer 渲染）
//  3) docs/cli-reference.md（scripts/gen-docs-helper.mjs 生成）
// 修改命令时只改这里，三处保持一致。

export const CLI_USAGE = 'ReqFlow.exe --cli <command> [options]';

export type CliCommandDoc = {
  name: string; // 完整命令名，如 "item add"
  args: string; // 参数摘要
  desc: string;
  example?: string;
};

export type CliGroupDoc = {
  group: string;
  desc: string;
  commands: CliCommandDoc[];
};

export const CLI_GLOBAL_OPTIONS: CliCommandDoc[] = [
  { name: '--data-dir <path>', args: '全局', desc: '覆盖数据目录（安装版默认为安装时所选目录，未选过则 %APPDATA%/ReqFlow；便携版默认 exe 同级 data\\；workspace.json 保存在该目录下）' },
  { name: '--pretty', args: '全局', desc: '以缩进格式输出 JSON，便于人工阅读（默认单行 JSON，便于程序解析）' },
  { name: '--out <file>', args: '全局', desc: '除 stdout 外，把输出同时写入指定文件（适合保存 Prompt 全文）' }
];

export const CLI_DOCS: CliGroupDoc[] = [
  {
    group: '基础',
    desc: '帮助、版本与工作区整体读写。',
    commands: [
      { name: 'help', args: '', desc: '显示 CLI 帮助（本参考的文本版）', example: 'ReqFlow.exe --cli help' },
      { name: 'version', args: '', desc: '输出版本信息（应用版本 / 数据文件路径）', example: 'ReqFlow.exe --cli version' },
      { name: 'plugin version', args: '--host <codex|zcode|pi|claude-code> [--plugin-version <x.y.z>]', desc: '查询当前 ReqFlow 内置的最新插件版本、SHA256 与更新状态', example: 'ReqFlow.exe --cli plugin version --host codex --plugin-version 0.2.1' },
      { name: 'plugin bundle', args: '--host <codex|zcode|pi|claude-code>', desc: '读取当前 ReqFlow 内置插件文件及 SHA256，供插件启动前自动更新使用' },
      { name: 'execution claim', args: '--project <id> --client <codex|zcode|pi|claude-code> --run <UUID> --claims <JSON数组>', desc: '事务领取 AI 排期任务；claims 每项包含 id/version/batchId/hash。返回成功领取项与跳过原因，执行中任务不会被覆盖' },
      { name: 'execution release', args: '--project <id> --id <需求ID> [--run <UUID>] [--note <说明>]', desc: '显式释放已停止的 AI 任务，保留结束时间和用时；指定运行 ID 时仅允许释放自己的任务' },
      { name: 'workspace get', args: '', desc: '读取完整工作区，返回 {version, state}；state.projects 为项目数组', example: 'ReqFlow.exe --cli workspace get' },
      { name: 'workspace export', args: '[--out <file>]', desc: '导出完整工作区 JSON（等价于界面「导出全部数据」）', example: 'ReqFlow.exe --cli workspace export --out backup.json' },
      {
        name: 'workspace import',
        args: '--file <path> [--replace]',
        desc: '导入界面或 export 导出的完整工作区 JSON；工作区已有数据时必须加 --replace 覆盖',
        example: 'ReqFlow.exe --cli workspace import --file backup.json --replace'
      }
    ]
  },
  {
    group: '项目与引导词',
    desc: '项目是需求与批次的容器；引导词决定生成 Prompt 的项目级指令。',
    commands: [
      { name: 'project list', args: '', desc: '项目列表，含 id、名称与各状态需求数量', example: 'ReqFlow.exe --cli project list' },
      { name: 'project create', args: '--name <名称> [--description <背景>]', desc: '新建项目并返回其 id', example: 'ReqFlow.exe --cli project create --name "官网改版"' },
      { name: 'project delete', args: '--project <id>', desc: '删除项目及其全部需求、批次与历史（不可恢复；至少保留一个项目，删除前建议 workspace export 备份）', example: 'ReqFlow.exe --cli project delete --project <id>' },
      { name: 'project show', args: '--project <id>', desc: '项目详情：背景、引导词、默认交付引导、AI 验证默认值', example: 'ReqFlow.exe --cli project show --project <id>' },
      { name: 'guidance set', args: '--project <id> --text <引导词> [--delivery <交付引导>]', desc: '更新项目引导词（guideVersion +1，旧版本进入历史）；旧批次快照会提示失效', example: 'ReqFlow.exe --cli guidance set --project <id> --text "遵循现有架构"' }
    ]
  },
  {
    group: '需求',
    desc: '需求状态流：待执行 ready → 执行中 in_progress → 待验证 pending_verification → 归档 archived。只有待执行需求可编辑。',
    commands: [
      {
        name: 'item add',
        args: '--project <id> [--title <标题>] [--body <说明>] [--type feature|improvement|bug] [--priority P0|P1|P2] [--criteria <条件>] [--delivery <交付引导>] [--date YYYY-MM-DD] [--executor ai|human|plugin:<id>|agent:<id>]',
        desc: '新增需求（保存后即为待执行）。标题选填，留空时 Prompt 中仅显示需求编号；type/priority 缺省为 feature/P1；executor 缺省为 ai；criteria 用分号或换行分隔多条验收条件',
        example: 'ReqFlow.exe --cli item add --project <id> --title "登录限流" --type bug --priority P0 --criteria "连续失败5次锁定;解锁需管理员"'
      },
      { name: 'item list', args: '[--project <id>] [--status <状态>] [--search <关键词>] [--executor <执行器>]', desc: '需求列表（默认排除已归档；不传 --project 时返回全部项目并附 projectId）', example: 'ReqFlow.exe --cli item list --status ready' },
      { name: 'item show', args: '--project <id> --id <需求ID>', desc: '需求详情（含验收条件、版本、未解决问题）', example: 'ReqFlow.exe --cli item show --project <id> --id <需求ID>' },
      { name: 'item edit', args: '--project <id> --id <需求ID> [--title/--body/--type/--priority/--criteria/--delivery/--date/--executor]', desc: '编辑待执行需求，只改传入的字段（未传字段保留原值）；每次编辑版本 +1', example: 'ReqFlow.exe --cli item edit --project <id> --id <需求ID> --priority P0' },
      { name: 'item history', args: '--project <id> --id <需求ID>', desc: '需求的操作与验证历史', example: 'ReqFlow.exe --cli item history --project <id> --id <需求ID>' }
    ]
  },
  {
    group: 'Prompt 批次',
    desc: '从待执行或执行中需求生成快照批次：执行中的需求可与新增需求累积生成。生成 → 复制给 AI → 确认提交 → 实现完成 → 人工验证。',
    commands: [
      { name: 'generate', args: '--project <id> --items <id1,id2,...>', desc: '按给定顺序从待执行或执行中需求生成 Prompt 批次（执行中需求可与新增需求累积生成，也可单独生成；状态 draft，含全文与 SHA-256）', example: 'ReqFlow.exe --cli generate --project <id> --items <id1>,<id2>' },
      { name: 'batch list', args: '--project <id>', desc: '批次列表：编号、状态（未提交/已提交/已取消）、需求、哈希', example: 'ReqFlow.exe --cli batch list --project <id>' },
      { name: 'batch show', args: '--project <id> --id <批次ID> [--out <file>]', desc: '批次详情，含 Prompt 全文（可直接 --out 保存为 .md 交给 AI）', example: 'ReqFlow.exe --cli batch show --project <id> --id <批次ID> --out prompt.md' },
      { name: 'submit', args: '--project <id> --batch <批次ID>', desc: '确认已提交给 AI；批次内需求进入执行中（已执行中的需求保持执行中并记录新批次）', example: 'ReqFlow.exe --cli submit --project <id> --batch <批次ID>' },
      { name: 'cancel', args: '--project <id> --batch <批次ID>', desc: '取消已提交批次；执行中需求退回待执行（若仍被其他已提交批次包含则保持执行中）', example: 'ReqFlow.exe --cli cancel --project <id> --batch <批次ID>' }
    ]
  },
  {
    group: '执行与验收',
    desc: '对单条需求推进状态；验证未通过的原因会自动带入下一轮 Prompt。',
    commands: [
      { name: 'complete', args: '--project <id> --id <需求ID> [--link <链接>] [--note <完整报告>] [--summary <50字内完成说明>] [--batch <排期批次ID> --item-version <版本>]', desc: '实现完成：执行中或有效排期 → 待验证；summary 显示在验证提示上方，省略时从 note 提取最多50字；带 batch/item-version 时原子核对 AI 执行标识及排期版本', example: 'ReqFlow.exe --cli complete --project <id> --id <需求ID> --summary "已完成布局调整，构建检查通过"' },
      { name: 'item completion-note', args: '--project <id> --id <需求ID> --summary <50字内完成说明> [--item-version <版本>]', desc: '补写当前版本待验证需求的开发完成说明；空白、超过50字或非待验证状态均拒绝', example: 'ReqFlow.exe --cli item completion-note --project <id> --id <需求ID> --summary "已补齐CLI接口，生命周期检查通过"' },
      { name: 'revert', args: '--project <id> --id <需求ID> [--note <原因>]', desc: '退回待执行：执行中 → 待执行（退回后可编辑，同批次其他需求不受影响）', example: 'ReqFlow.exe --cli revert --project <id> --id <需求ID>' },
      { name: 'verify', args: '--project <id> --id <需求ID> --pass <true|false> [--note <原因>]', desc: '人工验证：通过 → 归档；未通过 → 退回待执行并记录原因', example: 'ReqFlow.exe --cli verify --project <id> --id <需求ID> --pass false --note "样式未生效"' },
      { name: 'regress', args: '--project <id> --id <需求ID> [--note <回归原因>]', desc: '归档需求回归：退回待执行，原因带入下一轮 Prompt', example: 'ReqFlow.exe --cli regress --project <id> --id <需求ID> --note "线上复现"' },
      { name: 'archive', args: '--project <id> --id <需求ID>', desc: '直接归档需求（保留历史）', example: 'ReqFlow.exe --cli archive --project <id> --id <需求ID>' }
    ]
  }
];

export const CLI_NOTES: string[] = [
  '所有命令输出单行 JSON：成功 {"ok":true,...}，失败 {"ok":false,"error":"原因"}；退出码成功 0、失败 1，便于脚本与 Agent 判断。',
  'Windows 图形界面程序的输出在「直接双击 / 部分终端直接运行」时可能不显示；用管道或重定向一定能拿到：ReqFlow.exe --cli help | more，或 ... > out.json。子进程（spawn/execFile）管道读取始终有效。',
  'CLI 与图形界面共用同一份 workspace.json。界面按所触及项目的 revision 比对，同项目变化提示冲突，其他项目变化可安全重读合并；全局操作仍比对工作区版本。CLI 冲突自动重读重试，文件提交使用短时跨进程锁。',
  '常用 id 获取顺序：project list → item list / batch list。需求 id、批次 id 均为 UUID。',
  '典型 Agent 对接流程：project list → item add（若干条）→ item list 取 id → generate → batch show 取 Prompt 全文发给模型 → submit → （模型完成后）complete → verify。'
];

export function renderCliHelpText(version: string): string {
  const lines: string[] = [];
  lines.push('ReqFlow v' + version + ' — CLI 命令参考');
  lines.push('用法：' + CLI_USAGE);
  lines.push('');
  lines.push('全局选项：');
  for (const o of CLI_GLOBAL_OPTIONS) lines.push('  ' + o.name.padEnd(18) + ' ' + o.desc);
  for (const g of CLI_DOCS) {
    lines.push('');
    lines.push('## ' + g.group + ' — ' + g.desc);
    for (const c of g.commands) {
      lines.push('  ' + c.name + ' ' + c.args);
      lines.push('      ' + c.desc);
      if (c.example) lines.push('      例：' + c.example);
    }
  }
  lines.push('');
  lines.push('说明：');
  for (const n of CLI_NOTES) lines.push('  - ' + n);
  return lines.join('\n');
}
