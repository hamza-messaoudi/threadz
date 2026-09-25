import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { StreamParser, type RunnerEvent } from '../server/runner/parse.ts';

function parseFixture(name: string, chunk = 97): RunnerEvent[] {
  const text = fs.readFileSync(`test/fixtures/stream/${name}.jsonl`, 'utf8');
  const events: RunnerEvent[] = [];
  const p = new StreamParser((e) => events.push(e));
  for (let i = 0; i < text.length; i += chunk) p.feed(text.slice(i, i + chunk)); // arbitrary chunk boundaries
  p.end();
  return events;
}

describe('stream parser', () => {
  it('parses init, text deltas, tool use/result and result from a recorded run', () => {
    const ev = parseFixture('basic');
    const init = ev.find((e) => e.type === 'init') as any;
    expect(init.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(init.tools).toContain('Read');
    const text = ev.filter((e) => e.type === 'textDelta').map((e: any) => e.text).join('');
    expect(text).toBe('hello spike file');
    const tool = ev.find((e) => e.type === 'toolUse') as any;
    expect(tool.name).toBe('Read');
    const res = ev.find((e) => e.type === 'toolResult') as any;
    expect(res.id).toBe(tool.id);
    expect(res.preview).toContain('hello spike file');
    expect(res.denied).toBe(false);
    const result = ev.find((e) => e.type === 'result') as any;
    expect(result.isError).toBe(false);
    expect(result.usage.cache_read_input_tokens).toBeGreaterThan(0);
    const first = ev.find((e) => e.type === 'firstUsage') as any;
    expect(first.usage.cache_creation_input_tokens).toBe(12965);
  });

  it('uses full assistant messages when there are no partial deltas', () => {
    const ev = parseFixture('turn2-resume');
    expect(ev.filter((e) => e.type === 'textDelta').map((e: any) => e.text).join('')).toBe('two');
  });

  it('surfaces thinking summaries, streamed or whole, one block each', () => {
    const events: RunnerEvent[] = [];
    const p = new StreamParser((e) => events.push(e));
    const line = (o: unknown) => p.feed(JSON.stringify(o) + '\n');
    const delta = (index: number, delta: unknown) => line({ type: 'stream_event', event: { type: 'content_block_delta', index, delta } });
    line({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } });
    delta(0, { type: 'thinking_delta', thinking: '' });
    delta(0, { type: 'thinking_delta', thinking: '391 is ' });
    delta(0, { type: 'thinking_delta', thinking: '17 × 23.' });
    delta(1, { type: 'text_delta', text: 'Not prime.' });
    line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: '391 is 17 × 23.' }] } });
    // A run without partial messages: the thinking arrives whole.
    line({ type: 'assistant', message: { id: 'm2', content: [{ type: 'thinking', thinking: 'Plan the reply.' }] } });
    line({ type: 'assistant', message: { id: 'm2', content: [{ type: 'thinking', thinking: '' }] } });
    const thinking = events.filter((e) => e.type === 'thinkingDelta') as Extract<RunnerEvent, { type: 'thinkingDelta' }>[];
    expect(thinking.map((e) => e.text)).toEqual(['391 is ', '17 × 23.', 'Plan the reply.']);
    expect(thinking[0].block).toBe(thinking[1].block);
    expect(thinking[2].block).not.toBe(thinking[0].block);
  });

  it('marks hook-denied tool results', () => {
    const ev = parseFixture('hook-deny');
    const results = ev.filter((e) => e.type === 'toolResult') as any[];
    expect(results.some((r) => r.denied)).toBe(true);
    expect(results.filter((r) => r.denied).length).toBe(1);
  });

  it('ignores subagent traffic and reports errors', () => {
    const ev = parseFixture('mcp-and-subagent');
    expect(ev.filter((e) => e.type === 'toolUse').map((e: any) => e.name)).not.toContain('Write'); // Write ran inside the subagent
    const err = parseFixture('error-resume-missing').find((e) => e.type === 'result') as any;
    expect(err.isError).toBe(true);
    expect(err.errors.join()).toContain('No conversation found');
  });
});
