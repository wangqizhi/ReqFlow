import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { TerminalWindow } from './publish-terminal';
import './styles.css';
import { installDraggableOverlays } from './draggable-overlays';
installDraggableOverlays();

const params = new URLSearchParams(location.search);
const terminalRunId = params.get('terminal');
// REQ-212：指派终端在独立窗口打开时带 agent 参数，其余终端继续显示发布进度。
const terminalAgent = params.get('agent') || '';
const terminalProject = params.get('project') || '';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {terminalRunId
      ? <TerminalWindow runId={terminalRunId} project={terminalProject} agent={terminalAgent} />
      : <App />}
  </StrictMode>
);
