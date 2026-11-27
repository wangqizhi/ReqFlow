import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { BrowserWindow } from './browser-window';
import { TerminalWindow } from './publish-terminal';
import './styles.css';
import { installDraggableOverlays } from './draggable-overlays';
import { ShutdownDialog } from './shutdown';
import { applyCachedTheme, loadPreferencesFromBridge } from './preferences';
// REQ-343：首屏渲染前按本地缓存应用配色，再从数据目录同步最新偏好（独立窗口同样跟随）
applyCachedTheme();
void loadPreferencesFromBridge().catch(() => { /* 读取失败保持缓存配色 */ });
installDraggableOverlays();

const params = new URLSearchParams(location.search);
const browserProjectId = params.get('browser');
const terminalRunId = params.get('terminal');
// REQ-212：指派终端在独立窗口打开时带 agent 参数，其余终端继续显示发布进度。
const terminalAgent = params.get('agent') || '';
const terminalProject = params.get('project') || '';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {browserProjectId ? <BrowserWindow id={browserProjectId} /> : terminalRunId
      ? <TerminalWindow runId={terminalRunId} project={terminalProject} agent={terminalAgent} />
      : <><App /><ShutdownDialog /></>}
  </StrictMode>
);
