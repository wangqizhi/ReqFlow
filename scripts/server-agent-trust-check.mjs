import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/renderer/server-agent-trust.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { trustServerAgentDraft } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const fingerprint = 'ab'.repeat(32);
const draft = { name: 'NAS', host: '10.0.0.1', port: 8787, tlsMode: 'pin', token: 'draft-token' };
const calls = [];
const api = {
  async saveServerAgent(config) { calls.push(['save', config]); return { ok: true, id: config.id || 'saved-id' }; },
  async trustServerAgent(id, confirmed) { calls.push(['trust', id, confirmed]); return { ok: true }; },
};
const onSaved = id => calls.push(['saved', id]);
assert.equal(await trustServerAgentDraft(api, undefined, draft, fingerprint, onSaved), 'saved-id');
assert.deepEqual(calls, [['save', { ...draft, id: undefined }], ['saved', 'saved-id'], ['trust', 'saved-id', fingerprint]]);
calls.length = 0;
assert.equal(await trustServerAgentDraft(api, 'existing', undefined, fingerprint, onSaved), 'existing');
assert.deepEqual(calls, [['trust', 'existing', fingerprint]]);
calls.length = 0;
assert.equal(await trustServerAgentDraft(api, 'existing', draft, fingerprint, onSaved), 'existing');
assert.equal(calls[0][1].token, 'draft-token', 'edited token must be saved before trust');
assert.equal(calls[0][1].id, 'existing', 'edited endpoint keeps its saved identity');
calls.length = 0;
await assert.rejects(trustServerAgentDraft({ ...api, async saveServerAgent() { return { ok: false, error: 'save failed' }; } }, undefined, draft, fingerprint, onSaved), /save failed/);
assert.deepEqual(calls, [], 'save failure must never trust or connect');
await assert.rejects(trustServerAgentDraft({ ...api, async saveServerAgent() { return { ok: true }; } }, undefined, draft, fingerprint, onSaved), /保存服务端配置失败/);
const failingTrust = { ...api, async trustServerAgent() { throw Error('certificate changed'); } };
let retainedId;
await assert.rejects(trustServerAgentDraft(failingTrust, undefined, draft, fingerprint, id => { retainedId = id; }), /certificate changed/);
assert.equal(retainedId, 'saved-id', 'keep the saved ID after trust failure to avoid duplicate configurations on retry');
calls.length = 0;
await trustServerAgentDraft(api, retainedId, draft, fingerprint, onSaved);
assert.equal(calls[0][1].id, retainedId);
calls.length = 0;
await assert.rejects(trustServerAgentDraft(api, undefined, draft, undefined, onSaved), /缺少待确认/);
await assert.rejects(trustServerAgentDraft(api, undefined, undefined, fingerprint, onSaved), /请先保存/);
assert.deepEqual(calls, []);
console.log('PASS: save draft before trust, preserve edits and confirmed fingerprint, stop on failures, retain saved IDs for retry');
