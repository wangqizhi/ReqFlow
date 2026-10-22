// Cordis driver loaded over the user's headless profile for this launch only.
// Keep the plugin tree and Agent alive across turns; stdout is NDJSON.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

export const name = 'reqflow-chat-runtime';
export const inject = ['agents', 'sessions', 'agentDefaultModel'];
export function apply(ctx) {
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  const report = error => send({ type: 'error', message: error?.message || String(error) });
  const start = async () => {
    await ctx.get('loader')?.await();
    const require = createRequire(process.env.REQFLOW_DSH_BIN);
    const load = spec => import(pathToFileURL(require.resolve(spec)).href);
    const [{ installModelSelection }, { createUserMessage }] = await Promise.all([
      load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-llm'),
    ]);
    const agents = ctx.get('agents'), sessions = ctx.get('sessions');
    let handle, agent, answer = '', failure;
    const onEvent = ctx.on('session/event', (session, event) => {
      if (session !== agent?.session) return;
      const data = event.data;
      switch (event.type) {
        case 'step/start': send({ type: 'status', phase: 'step_start' }); break;
        case 'turn/end':
          failure = data.reason?.kind === 'error' ? new Error(data.reason.error?.message || '运行失败') : undefined;
          send({ type: 'status', phase: 'turn_end', reason: data.reason });
          break;
        case 'assistant/message':
          answer = data.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
          for (const block of data.message.content) {
            if (block.type === 'text' || block.type === 'reasoning') send({ type: block.type === 'text' ? 'text' : 'thinking', text: block.text });
          }
          break;
        case 'tool/call': {
          let input; try { input = JSON.parse(data.arguments || '{}'); } catch { input = {}; }
          send({ type: 'tool_call', tool: data.name, input }); break;
        }
        case 'tool/result':
          if (event.surfaceOp === 'append') send({ type: 'tool_result', status: data.message.isError ? 'error' : 'completed', result: data.message.content.filter(b => b.type === 'text').map(b => b.text).join('') });
          break;
      }
    });
    const onError = ctx.on('agent/error', ({ agent: subject, error }) => { if (subject === agent) { failure = error; report(error); } });
    const input = createInterface({ input: process.stdin });
    let chain = Promise.resolve(), cancelEpoch = 0;
    const turn = async request => {
      answer = ''; failure = undefined;
      try {
        if (request.fresh && handle) {
          await sessions.flush(agent.session);
          await handle.dispose(); handle = undefined; agent = undefined;
        }
        if (!agent) {
          const selection = ctx.get('agentDefaultModel').currentSelection();
          handle = await agents.create({ sessionId: `session-${randomUUID()}`, meta: { cwd: process.cwd() },
            agentOptions: { provider: selection.provider, model: selection.model },
            setup: agentCtx => { installModelSelection(agentCtx, { current: selection, assembled: undefined }); },
          });
          agent = handle.agent;
        }
        if (request.epoch !== cancelEpoch) return;
        send({ type: 'session', sessionId: agent.id });
        agent.followup(createUserMessage({ content: [{ type: 'text', text: request.task }], source: { kind: 'user' } }));
        const subagents = ctx.get('subagents');
        while (true) {
          await agent.whenIdle();
          const seq = agent.session.seq;
          if (!await subagents?.waitForChildren(agent) && agent.status === 'idle' && agent.session.seq === seq) break;
        }
        await sessions.flush(agent.session);
        if (failure) report(failure);
      } catch (error) { report(error); }
      finally { send({ type: 'final', text: answer }); }
    };
    input.on('line', line => {
      let request;
      try { request = JSON.parse(line); } catch { return; }
      if (request.type === 'cancel') { cancelEpoch++; agent?.cancel({ kind: 'user' }); return; }
      if (request.type === 'prompt' && typeof request.task === 'string') { request.epoch = cancelEpoch; chain = chain.then(() => turn(request)).catch(report); }
    });
    input.on('close', () => { void chain.finally(() => ctx.get('appExit')?.(0)); });
    ctx.on('dispose', () => { input.close(); onEvent(); onError(); });
    send({ type: 'ready' });
  };
  void start().catch(error => { report(error); ctx.get('appExit')?.(1); });
}
