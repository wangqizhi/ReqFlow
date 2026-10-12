// 结构化阶段标记供桌面发布日志读取；命令行也能看到开始、结束与耗时。
export function startStep(stage) {
  const started = performance.now();
  console.log('@@REQFLOW_PUBLISH ' + JSON.stringify({ stage, phase: 'start' }));
  return (ok = true) => console.log('@@REQFLOW_PUBLISH ' + JSON.stringify({ stage, phase: ok ? 'complete' : 'error', elapsedMs: Math.round(performance.now() - started) }));
}

export function traceStep(stage, action) {
  const end = startStep(stage);
  try {
    const result = action();
    if (result?.then) return result.then(value => { end(); return value; }, error => { end(false); throw error; });
    end();
    return result;
  } catch (error) { end(false); throw error; }
}
