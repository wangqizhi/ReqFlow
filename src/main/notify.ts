// 发布结果系统通知（REQ-110）：发布脚本执行完毕时，若主窗口不在最前端，
// 用系统通知提示完成/失败，避免用户在应用外等待时错过结果。
// 平台分发预留：Windows 已接入（Electron Notification，依赖 com.reqflow.desktop
// AppUserModelID，已在 index.ts 设置）；macOS / Linux 后续在此注册对应实现，
// notifyPublishResult 的调用方接口保持不变。
import { BrowserWindow, Notification } from 'electron';
import path from 'node:path';

export type PublishNotice = { ok: boolean; title: string; body: string };

/** 窗口最小化或未持有焦点（被其他窗口/应用遮挡）都视为「不在最前端」。 */
export function windowInBackground(win: BrowserWindow | null | undefined): boolean {
  return !win || win.isMinimized() || !win.isFocused();
}

/** 前台运行时静默返回 false；不在最前端时按平台弹出系统通知，返回是否已提示。 */
export function notifyPublishResult(win: BrowserWindow | null | undefined, notice: PublishNotice): boolean {
  if (!windowInBackground(win)) return false;
  return showNotification(win, notice);
}

function showNotification(win: BrowserWindow | null | undefined, notice: PublishNotice): boolean {
  if (process.platform === 'win32') {
    if (!Notification.isSupported()) return false;
    const notification = new Notification({
      title: notice.title,
      body: notice.body,
      icon: path.join(__dirname, 'icon.ico'),
      // 与应用内提示一致：完成用静默默认音，失败保留系统提示音以便区分
      silent: notice.ok
    });
    // 点击通知回到 ReqFlow 窗口查看发布输出
    notification.on('click', () => {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    });
    notification.show();
    return true;
  }
  return false; // darwin / linux 预留接入点
}
