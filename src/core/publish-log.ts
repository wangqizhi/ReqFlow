export type PublishLogSettings = { enabled: boolean };
export type PublishRequestLog = {
  time: string;
  requestId: string;
  project: string;
  script: string;
  phase: 'request' | 'stage_start' | 'stage_complete' | 'output' | 'progress' | 'complete' | 'error';
  stage: string;
  elapsedMs: number;
  durationMs?: number;
  text?: string;
};
