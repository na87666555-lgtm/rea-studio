import test from 'node:test';
import assert from 'node:assert/strict';
import { runTeam, resolveTeam, suggestTeam } from '../js/team.js';

const connections = ['gpt-test', 'gemini-test', 'claude-test'].map((model, i) => ({
  id: `api-${i}`, defaultModel: model, models: [model], apiKey: `secret-${i}`,
  format: i === 2 ? 'anthropic' : 'openai', maxParallel: 3,
}));
const members = () => resolveTeam({ members: suggestTeam(connections) }, connections);
const response = (text = 'contribution') => ({ text, toolCalls: [], assistantMessage: { role: 'assistant', content: text } });
function setup(extra = {}) {
  const events = { members: [], phases: [], output: '' };
  const controller = new AbortController();
  return { events, controller, opts: { members: members(), signal: controller.signal,
    getHistory: async () => [{ role: 'user', content: 'shared project: build a calculator' }],
    onMember: (i, m) => { events.members[i] = m; }, onPhase: p => events.phases.push(p),
    onText: t => { events.output += t; }, ...extra } };
}

test('all three draft concurrently; synthesis sees all contributions and the shared history, without keys', async () => {
  let active = 0; let peak = 0; const calls = [];
  const s = setup({ turn: async args => {
    calls.push(args);
    if (!args.system.includes('ONE useful final answer')) {
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 15)); active--;
      args.onText(`${args.model}: useful evidence`); return response();
    }
    const prompt = JSON.stringify(args.history);
    for (const c of connections) { assert.ok(prompt.includes(c.defaultModel)); assert.ok(!prompt.includes(c.apiKey)); }
    assert.ok(prompt.includes('shared project'));
    args.onText('One combined answer'); return response();
  } });
  const result = await runTeam(s.opts);
  assert.equal(peak, 3); assert.equal(calls.length, 4);
  assert.equal(s.events.output, 'One combined answer');
  assert.equal(result.completed, 3); assert.equal(result.coordinator, 'Claude');
  assert.deepEqual(s.events.phases, ['drafts', 'synthesis', 'done']);
});

test('a failed coordinator falls back to a successful contributor and is reported', async () => {
  const s = setup({ turn: async args => {
    if (args.model === 'claude-test') throw new Error('HTTP 429');
    args.onText('available'); return response();
  } });
  const r = await runTeam(s.opts);
  assert.equal(r.completed, 2); assert.equal(r.coordinator, 'ChatGPT');
  assert.equal(s.events.members[2].status, 'error');
  assert.equal(s.events.members[2].error, 'HTTP 429');
});

test('no fabricated synthesis when every provider fails', async () => {
  const s = setup({ turn: async () => { throw new Error('invalid key'); } });
  await assert.rejects(runTeam(s.opts), /तीनों से जवाब नहीं मिला/);
  assert.equal(s.events.output, ''); assert.ok(!s.events.phases.includes('synthesis'));
});

test('stop aborts running and queued members and prevents synthesis', async () => {
  const s = setup({ turn: args => new Promise((resolve, reject) => {
    args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true });
  }) });
  s.opts.members.forEach(m => { m.conn.id = 'shared-stop'; m.conn.maxParallel = 1; });
  const job = runTeam(s.opts); setTimeout(() => s.controller.abort(), 15);
  await assert.rejects(job, { name: 'AbortError' });
  assert.ok(s.events.members.every(m => m.status === 'stopped'));
  assert.ok(!s.events.phases.includes('synthesis'));
});

test('one provider concurrency limit applies across all three members', async () => {
  let active = 0; let peak = 0;
  const s = setup({ turn: async args => {
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5)); active--;
    args.onText('done'); return response();
  } });
  s.opts.members.forEach(m => { m.conn.id = 'shared-limit'; m.conn.maxParallel = 1; });
  await runTeam(s.opts); assert.equal(peak, 1);
});

test('a timed-out contributor does not prevent remaining members from finishing', async () => {
  const s = setup({ timeoutMs: 30, turn: async args => {
    if (args.model === 'gemini-test') return new Promise((resolve, reject) => {
      args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true });
    });
    args.onText('done'); return response();
  } });
  const r = await runTeam(s.opts);
  assert.equal(r.completed, 2); assert.equal(s.events.members[1].status, 'error');
});

test('tools use the correct wire format and evidence reaches the shared answer', async () => {
  const s = setup({ tools: [{ name: 'web_search' }],
    executeTool: async () => ({ ok: true, text: 'verified-source' }),
    turn: async args => {
      if (args.system.includes('ONE useful final answer')) {
        assert.ok(JSON.stringify(args.history).includes('verified-source'));
        args.onText('final'); return response();
      }
      if (!args.trail.length) return { toolCalls: [{ id: 'call', name: 'web_search', args: { query: 'test' } }], assistantMessage: { role: 'assistant', content: 'search' } };
      assert.ok(JSON.stringify(args.trail).includes('verified-source'));
      if (args.conn.format === 'anthropic') assert.equal(args.trail[1].content[0].type, 'tool_result');
      else assert.equal(args.trail[1].role, 'tool');
      args.onText('evidence based draft'); return response();
    } });
  await runTeam(s.opts); assert.ok(s.events.members.every(m => m.steps[0].status === 'done'));
});

test('shared attachments reach each member and incomplete team configuration fails early', async () => {
  const image = { mediaType: 'image/jpeg', data: 'test-base64' };
  const s = setup({ getHistory: async () => [{ role: 'user', content: 'Look at this', images: [image] }],
    turn: async args => { assert.deepEqual(args.history[0].images, [image]); args.onText('image checked'); return response(); } });
  await runTeam(s.opts);
  assert.throws(() => resolveTeam({ members: suggestTeam([]) }, connections), /API कनेक्शन/);
});
