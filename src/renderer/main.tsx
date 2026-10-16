import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { PublishTerminalWindow } from './publish-terminal';
import './styles.css';
import { installDraggableOverlays } from './draggable-overlays';
installDraggableOverlays();

const terminalRunId = new URLSearchParams(location.search).get('terminal');
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {terminalRunId ? <PublishTerminalWindow runId={terminalRunId} /> : <App />}
  </StrictMode>
);
