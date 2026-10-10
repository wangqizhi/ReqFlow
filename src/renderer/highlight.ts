// 极简语法高亮 —— 零依赖，为「浏览项目」编辑器提供覆盖层着色。
// 输出安全 HTML：源文本按 token 逐段转义后再包裹 <span class="tk-x">。
// 覆盖常见语言族：js/ts、json、css、html/xml、python、shell、bat、powershell、
// sql、C 系（java/c/cpp/cs/go/rust/php…）、配置（yaml/ini/env）与 markdown。

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const span = (cls: string, text: string) => `<span class="tk-${cls}">${esc(text)}</span>`;

type LangCfg = {
  line?: string[];                 // 行注释起始符（词边界后生效）
  lineCI?: string[];               // 大小写不敏感的行注释（bat 的 rem）
  block?: [string, string][];      // 块注释
  keywords?: Set<string>;
  builtins?: Set<string>;
  ci?: boolean;                    // 关键字大小写不敏感（sql / bat / powershell）
  template?: boolean;              // 反引号模板字符串
  dollar?: boolean;                // $VAR 变量着色
  markup?: boolean;                // 标签/属性模式
  hex?: boolean;                   // #RRGGBB 颜色
};

const kw = (s: string) => new Set(s.split(/\s+/));

const JS_KW = kw(`const let var function class extends implements interface type enum new delete typeof instanceof
  in of if else for while do switch case default break continue return try catch finally throw async await yield
  static get set public private protected readonly export import from as namespace declare abstract super this
  void with debugger`);
const JS_BUILTIN = kw(`console window document Math JSON Object Array String Number Boolean Date RegExp Error
  Promise Map Set Symbol BigInt Proxy Reflect globalThis process require module exports localStorage navigator
  fetch setTimeout setInterval undefined null true false`);

const LANGS: Record<string, LangCfg> = {
  js: { line: ['//'], block: [['/*', '*/']], template: true, keywords: JS_KW, builtins: JS_BUILTIN },
  json: { builtins: kw('true false null') },
  css: {
    block: [['/*', '*/']], hex: true,
    keywords: kw('important media supports keyframes import from to and not only screen font-face root layer')
  },
  markup: { markup: true },
  py: {
    line: ['#'],
    keywords: kw(`def class if elif else for while break continue return import from as with try except finally
      raise lambda global nonlocal pass yield async await in is not and or del assert`),
    builtins: kw('None True False self cls print len range str int float list dict set tuple open type super isinstance enumerate zip map filter sum min max abs sorted')
  },
  sh: {
    line: ['#'], dollar: true,
    keywords: kw('if then else elif fi for in do done while until case esac function select time return exit local export readonly declare typeset unset echo cd source alias set shift trap')
  },
  bat: {
    line: ['::', '@REM'], lineCI: ['rem'], ci: true,
    keywords: kw('if exist else goto call exit for in do shift defined not equ neq lss leq gtr geq')
  },
  ps1: {
    line: ['#'], block: [['<#', '#>']], ci: true,
    keywords: kw('function param begin process end if elseif else foreach for while do switch try catch finally throw return filter in break continue local return')
  },
  sql: {
    line: ['--'], block: [['/*', '*/']], ci: true,
    keywords: kw(`select from where insert into values update delete create table drop alter add primary foreign
      key references join left right inner outer full cross on as and or not null is in between like order by group
      having limit offset distinct union all case when then else end exists default unique index view commit
      rollback begin transaction with asc desc`)
  },
  clike: {
    line: ['//'], block: [['/*', '*/']],
    keywords: kw(`int long short float double char bool boolean void byte auto var let final static public private
      protected internal class struct enum interface trait impl extends implements protocol namespace package use
      mod import include typedef template typename new delete this self super base return if else for foreach while
      do switch match case default break continue try catch except finally throw throws async await yield defer go
      chan func fn mut pub crate unsafe where type in is as from with using virtual override abstract sealed
      readonly null nullptr nil true false TRUE FALSE`),
    builtins: kw('std cout cin endl String Vec Option Result Some None Ok Err System out Integer Double Float Boolean Character List ArrayList HashMap')
  },
  conf: { line: ['#', ';'] },
  md: {}
};

/** 读一个字符串字面量（含转义；到行尾未闭合则止于行尾）。 */
function readString(src: string, start: number) {
  const q = src[start];
  let j = start + 1;
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === q) { j++; break; }
    if (src[j] === '\n') break;
    j++;
  }
  return { text: src.slice(start, Math.min(j, src.length)), end: Math.min(j, src.length) };
}

const isWordStart = (c: string) => /[A-Za-z_$]/.test(c);

function tokenize(src: string, cfg: LangCfg): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    // 块注释
    if (cfg.block) {
      const hit = cfg.block.find(([s]) => src.startsWith(s, i));
      if (hit) {
        const end = src.indexOf(hit[1], i + hit[0].length);
        const stop = end === -1 ? src.length : end + hit[1].length;
        out += span('c', src.slice(i, stop));
        i = stop;
        continue;
      }
    }

    // 行注释（需词边界：上一字符不能是字母数字_$，避免误伤 #include、url 片段等）
    const atBoundary = i === 0 || !/[\w$]/.test(src[i - 1]);
    if (atBoundary) {
      const lineTok = cfg.line?.find((s) => src.startsWith(s, i))
        || cfg.lineCI?.find((s) => src.slice(i, i + s.length).toLowerCase() === s.toLowerCase());
      if (lineTok) {
        const nl = src.indexOf('\n', i);
        const stop = nl === -1 ? src.length : nl;
        out += span('c', src.slice(i, stop));
        i = stop;
        continue;
      }
    }

    // 字符串
    if (ch === '"' || ch === "'" || (ch === '`' && cfg.template)) {
      const s = readString(src, i);
      out += span('s', s.text);
      i = s.end;
      continue;
    }

    // css 颜色 #abc / #aabbcc
    if (cfg.hex && ch === '#' && /[0-9a-fA-F]/.test(src[i + 1] || '')) {
      const m = /^#[0-9a-fA-F]{3,8}/.exec(src.slice(i));
      if (m) { out += span('n', m[0]); i += m[0].length; continue; }
    }

    // 数字
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^(0[xXbBoO][0-9a-fA-F]+|\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?)[\w]*/.exec(src.slice(i));
      let t = m ? m[0] : ch;
      while (t.endsWith('.')) t = t.slice(0, -1);
      out += span('n', t);
      i += t.length || 1;
      continue;
    }

    // shell 变量 $VAR / ${VAR}
    if (cfg.dollar && ch === '$' && isWordStart(src[i + 1] || '')) {
      const m = /^\$\{?[\w]+\}?/.exec(src.slice(i));
      if (m) { out += span('b', m[0]); i += m[0].length; continue; }
    }

    // 标签/属性（html/xml/svg/vue…）
    if (cfg.markup && ch === '<') {
      if (src.startsWith('<!--', i)) {
        const end = src.indexOf('-->', i);
        const stop = end === -1 ? src.length : end + 3;
        out += span('c', src.slice(i, stop));
        i = stop;
        continue;
      }
      let j = i + 1;
      out += esc('<');
      if (src[j] === '/' || src[j] === '!' || src[j] === '?') { out += esc(src[j]); j++; }
      const name = /^[A-Za-z][\w:.-]*/.exec(src.slice(j));
      if (name) { out += span('t', name[0]); j += name[0].length; }
      while (j < src.length && src[j] !== '>') {
        const cj = src[j];
        if (cj === '"' || cj === "'") {
          const s = readString(src, j);
          out += span('s', s.text);
          j = s.end;
          continue;
        }
        if (/[A-Za-z_:@]/.test(cj)) {
          const a = /^[A-Za-z_:@\-][\w:.\-]*/.exec(src.slice(j));
          if (a) { out += span('a', a[0]); j += a[0].length; continue; }
        }
        out += esc(cj);
        j++;
      }
      if (j < src.length) { out += esc('>'); j++; }
      i = j;
      continue;
    }

    // 标识符 / 关键字 / 函数调用
    if (isWordStart(ch)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))!;
      const w = m[0];
      const key = cfg.ci ? w.toLowerCase() : w;
      let k = i + w.length;
      while (src[k] === ' ') k++;
      if (cfg.keywords?.has(key)) out += span('k', w);
      else if (cfg.builtins?.has(key)) out += span('b', w);
      else if (src[k] === '(') out += span('f', w);
      else out += esc(w);
      i += w.length;
      continue;
    }

    out += esc(ch);
    i++;
  }
  return out;
}

/** markdown（编辑模式）：标题/引用整行着色 + 行内代码/加粗/列表标记。 */
function tokenizeMd(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      const e = esc(line);
      if (/^#{1,6}\s/.test(line)) return span('k', line);
      if (/^&gt;\s?/.test(e)) return span('c', line);
      if (/^\s*(```|~~~)/.test(line)) return span('b', line);
      const codes: string[] = [];
      let h = e.replace(/`[^`\n]+`/g, (m) => {
        codes.push('<span class="tk-s">' + m + '</span>');
        return '\u0000' + (codes.length - 1) + '\u0000';
      });
      h = h.replace(/\*\*[^*\n]+\*\*/g, (m) => '<span class="tk-b">' + m + '</span>');
      h = h.replace(/^(\s*)((?:[-*+]|\d+[.)]))\s/, (_m, p1: string, mark: string) => esc(p1) + '<span class="tk-f">' + esc(mark) + '</span> ');
      return h.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => codes[+n]);
    })
    .join('\n');
}

/** 高亮源码；lang 未知时返回纯转义文本（作为可见文本层）。 */
export function highlightCode(src: string, lang: string): string {
  if (!src) return '';
  let html: string;
  if (lang === 'md') html = tokenizeMd(src);
  else {
    const cfg = LANGS[lang];
    html = cfg ? tokenize(src, cfg) : esc(src);
  }
  // <pre> 解析会吞掉紧跟开始标签的一个换行：内容以空行开头时补一个保对齐
  if (html.startsWith('\n')) html = '\n' + html;
  return html;
}
