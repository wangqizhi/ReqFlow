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
