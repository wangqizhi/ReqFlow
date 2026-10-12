// Electron 主进程入口。
// - 普通启动：打开 ReqFlow 主窗口（加载打包产物或开发服务器）
// - `--cli <command>`：无窗口运行命令行模式，输出 JSON 后退出（供 Agent/脚本对接）

import { app } from 'electron';
import path from 'node:path';
import { Cli } from './cli';
import { resolveDataDir } from './data-dir';
import { registerIpc } from './ipc';

const args = process.argv.slice(app.isPackaged ? 1 : 2);
const cliIndex = args.indexOf('--cli');

if (cliIndex !== -1) {
  // CLI 模式：不创建窗口。stdout 在管道/重定向下有效（Agent 场景）。
  const cliArgs = args.slice(cliIndex + 1);
  app.whenReady().then(async () => {
    const cli = new Cli(cliArgs, app.getVersion(), resolveDataDir());
    const code = await cli.run();
    // 成功时仅正常退出；will-quit 中再次 app.exit(0) 会使 Windows 打包版崩溃。
    // 失败时保留指定非零退出码供 CLI 调用方判断。
    if (code !== 0) app.once('will-quit', () => app.exit(code));
    app.quit();
  });
} else {
  app.setAppUserModelId('com.reqflow.desktop');
  app.whenReady().then(() => {
    registerIpc(resolveDataDir());
    createWindow();
    app.on('activate', () => {
      if (require('electron').BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

function createWindow() {
  const { BrowserWindow, Menu } = require('electron');
  const win = new BrowserWindow({
    frame: false,
    width: 1440,
    height: 900,
    // 固定窗口尺寸：界面按此尺寸设计，长列表在各自区域内滚动
    resizable: false,
    maximizable: false,
    center: true,
    // REQ-072：主窗口等内容加载完成后再显示，期间由启动动画窗口承接视觉
    show: false,
    title: 'ReqFlow · 需求流',
    icon: path.join(__dirname, 'icon.ico'),
    backgroundColor: '#f5f4f1',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  const devUrl = process.env.REQFLOW_RENDERER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  // 阻止页面跳转离开应用（数据与操作都在本地窗口内完成）
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // REQ-063：置空应用菜单，原生顶部菜单栏彻底消失（Alt/F10 也无法唤出——
  // 此前仅 setMenuBarVisibility(false)，Windows 上菜单栏仍会随焦点切换/Alt 重新出现）。
  // 自定义标题栏在渲染层提供拖动区域与窗口控制。
  Menu.setApplicationMenu(null);
  win.setMenu(null);
  win.setMenuBarVisibility(false);

  // REQ-072：启动动画 —— 主窗口加载期间居中逐字显示 ReqFlow；
  // 等内容加载完成且动画完整放完，再显示主窗口并关闭动画窗口
  const splash = createSplashWindow();
  // 动画节奏（REQ-072 验证退回：提速保证播得完）：末字母 450ms 起入场、280ms 完成，
  // 副标题 750ms 起淡入、1050ms 结束；1100ms 时整段动画已播完，主窗口随即接管
  const minSplashMs = 1100;
  Promise.all([
    new Promise<void>((resolve) => win.once('ready-to-show', resolve)),
    new Promise((resolve) => setTimeout(resolve, minSplashMs))
  ]).then(() => {
    if (!win.isDestroyed()) win.show();
    if (!splash.isDestroyed()) splash.close();
  });
  // 兜底：ready-to-show 因异常未触发时，20 秒后强制收起动画并显示主窗口
  setTimeout(() => {
    if (!splash.isDestroyed()) splash.close();
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  }, 20000);

  // 屏蔽 Electron/Chromium 原生快捷键：F12、Ctrl+Shift+I/J/C（开发者工具）、
  // Ctrl+R / Ctrl+Shift+R / F5（刷新）、F10/F11（菜单/全屏）、Ctrl+F/G/P（查找/打印）、
  // Ctrl+=/-/0（缩放）与单独按 Alt（唤出菜单栏）。应用自身的 Ctrl+S / Ctrl+V 等不受影响。
  win.webContents.on('before-input-event', (event: Electron.Event, input: Electron.Input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    const ctrl = input.control || input.meta;
    const blocked =
      key === 'f12' || key === 'f5' || key === 'f10' || key === 'f11' ||
      (ctrl && key === 'r') ||
      (ctrl && input.shift && ['i', 'j', 'c'].includes(key)) ||
      (ctrl && !input.shift && ['f', 'g', 'p'].includes(key)) ||
      (ctrl && ['=', '-', '0'].includes(key)) ||
      (key === 'alt' && !ctrl && !input.shift);
    if (blocked) event.preventDefault();
  });
  // 打包版兜底：开发者工具一旦被任何途径打开立即关闭（开发模式保留调试能力）
  if (app.isPackaged) {
    win.webContents.on('devtools-opened', () => { win.webContents.closeDevTools(); });
  }
}

/** 启动动画窗口（REQ-072）：居中逐字出现 ReqFlow，附加载进度条与提示文字。 */
function createSplashWindow() {
  const { BrowserWindow } = require('electron');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#f5f4f1;font-family:"Segoe UI","Microsoft YaHei",sans-serif;overflow:hidden}
.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px}
.logo{font-size:44px;font-weight:700;color:#1c1917;letter-spacing:2px;line-height:1}
.logo span{opacity:0;display:inline-block;animation:letter-in .28s ease-out forwards}
.logo .caret{width:3px;height:38px;background:#c2410c;margin-left:5px;animation:blink .6s steps(1) infinite}
.bar{width:180px;height:3px;border-radius:2px;background:#e7e5e4;overflow:hidden;opacity:0;animation:fade-in .25s forwards;animation-delay:.55s}
.bar i{display:block;height:100%;width:40%;border-radius:2px;background:#c2410c;animation:slide 1.1s ease-in-out infinite}
.sub{font-size:13px;color:#6d6862;opacity:0;animation:fade-in .3s forwards;animation-delay:.75s}
@keyframes letter-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes fade-in{to{opacity:1}}
@keyframes blink{50%{opacity:0}}
@keyframes slide{0%{transform:translateX(-110%)}100%{transform:translateX(280%)}}
</style></head><body><div class="wrap"><div class="logo" id="logo"></div><div class="bar"><i></i></div><div class="sub">正在打开你的工作区…</div></div>
<script>
var text='ReqFlow',logo=document.getElementById('logo');
for(var i=0;i<text.length;i++){var s=document.createElement('span');s.textContent=text[i];s.style.animationDelay=(i*0.075)+'s';logo.appendChild(s);}
var caret=document.createElement('span');caret.className='caret';logo.appendChild(caret);
</script></body></html>`;
  const splash = new BrowserWindow({
    width: 460,
    height: 300,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    center: true,
    skipTaskbar: true,
    title: 'ReqFlow · 需求流',
    icon: path.join(__dirname, 'icon.ico'),
    backgroundColor: '#f5f4f1',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  splash.setMenuBarVisibility(false);
  splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return splash;
}
