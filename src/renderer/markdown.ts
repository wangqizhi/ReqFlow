// 极简 Markdown 渲染器 —— 零依赖、面向「浏览项目」的文档预览。
// 安全策略：先把原始文本整体 HTML 转义，再生成受控标签，不透传任何用户 HTML。
// 支持：标题 / 段落 / 粗斜体与删除线 / 行内代码 / 围栏代码块 / 引用 /
// 有序无序列表（含嵌套与任务列表）/ 分隔线 / 表格 / 链接 / 图片。
// 图片相对路径保留 data-src 属性，由前端经 IPC 解析为 data URL 后再赋给 src。

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 链接/图片目标：支持 `<含空格路径>` 包裹与末尾 "标题" 说明，返回纯地址。 */
function splitDest(dest: string): string {
  let d = dest.trim();
  if (d.startsWith('<') && d.endsWith('>')) d = d.slice(1, -1);
  else {
    const qi = d.indexOf('"');
    if (qi !== -1) d = d.slice(0, qi);
  }
  return d.trim();
}

/** 行内元素（输入为已转义文本）。 */
function inline(src: string): string {
  // 行内代码先抽成占位，避免内部内容再被其它规则改写
  const codes: string[] = [];
  let s = src.replace(/`([^`\n]+)`/g, (_m, c: string) => {
    codes.push(c);
    return '\u0000' + (codes.length - 1) + '\u0000';
  });
  // 图片：![alt](src) —— 网络图片直接显示；本地相对路径留给前端 IPC 解析
  s = s.replace(/!\[([^\]\n]*)\]\(([^)\n]*)\)/g, (_m, alt: string, raw: string) => {
    const isrc = splitDest(raw);
    if (!isrc) return raw.trim() ? alt : '';
    const a = alt.replace(/"/g, '&quot;');
    return /^https?:\/\//i.test(isrc)
      ? `<img src="${isrc}" alt="${a}" />`
      : `<img data-src="${isrc}" alt="${a}" />`;
  });
  // 链接：仅 http(s)/mailto 可点击（点击由前端接管，用系统浏览器打开）
  s = s.replace(/\[([^\]\n]+)\]\(([^)\n]*)\)/g, (_m, text: string, raw: string) => {
    const href = splitDest(raw);
    return /^(https?:|mailto:)/i.test(href) ? `<a href="${href}">${text}</a>` : text;
  });
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|\W)_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => `<code>${codes[+n]}</code>`);
}

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^#{1,6}\s+/;
const QUOTE = /^\s{0,3}&gt;/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+/;

/** 列表块（含嵌套）：返回渲染结果与消费到的行号。 */
function parseList(lines: string[], start: number): { html: string; next: number } {
  const first = lines[start].match(LIST_ITEM)!;
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(LIST_ITEM);
    if (!m || m[1].length < base) break;
    if (m[1].length === base) {
      // 同级新项：有序↔无序切换视为上一个列表结束
      if (/\d/.test(m[2]) !== ordered) break;
      items.push(lines[i].replace(LIST_ITEM, ''));
    } else {
      // 更深缩进：并入上一项（保留相对缩进，由递归解析成嵌套列表/续行）
      if (!items.length) items.push('');
      items[items.length - 1] += '\n' + lines[i].slice(base);
    }
    i++;
  }
  const lis = items
    .map((it) => {
      const nl = it.indexOf('\n');
      const head = (nl === -1 ? it : it.slice(0, nl)).trim();
      const rest = nl === -1 ? '' : it.slice(nl + 1);
      const task = head.match(/^\[([ xX])\]\s+(.*)$/);
      const headHtml = task
        ? `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'} /> ${inline(task[2])}`
        : inline(head);
      return `<li>${headHtml}${rest.trim() ? renderLines(rest.split('\n')) : ''}</li>`;
    })
    .join('');
  return { html: `<${ordered ? 'ol' : 'ul'}>${lis}</${ordered ? 'ol' : 'ul'}>`, next: i };
}

/** 块级解析主体。输入行均已做 HTML 转义（> 已变成 &gt;）。 */
function renderLines(lines: string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // 围栏代码块
    const fence = line.match(/^\s{0,3}(```|~~~)(.*)$/);
    if (fence) {
      const mark = fence[1][0];
      i++;
      const buf: string[] = [];
      const close = new RegExp('^\\s{0,3}\\' + mark + '{3,}\\s*$');
      while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++]);
      if (i < lines.length) i++; // 跳过闭合围栏
      out.push('<pre><code>' + buf.join('\n') + '</code></pre>');
      continue;
    }

    // 标题（行尾 # 装饰去掉）
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      out.push(`<h${lv}>${inline(h[2].replace(/\s+#+\s*$/, ''))}</h${lv}>`);
      i++;
      continue;
    }

    // 分隔线
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr />'); i++; continue; }

    // 引用块（递归渲染内部内容）
    if (QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}&gt;\s?/, ''));
      out.push('<blockquote>' + renderLines(buf) + '</blockquote>');
      continue;
    }

    // 表格：表头行 + | 分隔行（仅由 | : - 空格构成）
    if (line.includes('|') && i + 1 < lines.length &&
      /^[\s|:-]+$/.test(lines[i + 1]) && lines[i + 1].includes('|') && lines[i + 1].includes('-')) {
      const cells = (r: string) => r.replace(/^\s{0,3}\|/, '').replace(/\|\s{0,3}$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
      out.push(
        '<table><thead><tr>' + head.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + head.map((_c, k) => '<td>' + inline(r[k] ?? '') + '</td>').join('') + '</tr>').join('') +
        '</tbody></table>'
      );
      continue;
    }

    // 列表
    if (LIST_ITEM.test(line)) {
      const r = parseList(lines, i);
      out.push(r.html);
      i = r.next;
      continue;
    }

    // 段落：到空行或下一个块级语法为止
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() &&
      !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !QUOTE.test(lines[i]) && !LIST_ITEM.test(lines[i])) {
      buf.push(lines[i++]);
    }
    out.push('<p>' + inline(buf.join('\n')) + '</p>');
  }
  return out.join('\n');
}

export function renderMarkdown(src: string): string {
  if (!src) return '';
  return renderLines(esc(src.replace(/\r\n?/g, '\n')).split('\n'));
}
