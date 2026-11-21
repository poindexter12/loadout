import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError } from '../app/src/lib/api';
import { answerRefusal, answerRequest, canAnswer, composeAnswer, togglePick } from '../app/src/lib/components/questions/answer';

describe('dashboard question answer form (SQ-424)', () => {
  it('offers the form only on an open, unanswered question', () => {
    expect(canAnswer({ state: 'open', answer: null })).toBe(true);
    expect(canAnswer({ state: 'answered', answer: { aid: 'a_1', at: 'now', via: 'dashboard', declined: false } })).toBe(false);
    expect(canAnswer({ state: 'declined', answer: null })).toBe(false);
    expect(canAnswer(null)).toBe(false);
  });

  it('composes picked options and a note, and refuses an empty answer', () => {
    expect(composeAnswer(['v2'], '')).toBe('v2');
    expect(composeAnswer(['v1', 'v2'], '  keep the columns ')).toBe('v1, v2\nkeep the columns');
    expect(composeAnswer([], 'free text')).toBe('free text');
    expect(answerRequest([], '   ')).toBeNull();
    expect(answerRequest(['v2'], '')).toEqual({ text: 'v2' });
  });

  it('single select replaces the pick, multi select accumulates, and a second click clears', () => {
    expect(togglePick(['v1'], 'v2', false)).toEqual(['v2']);
    expect(togglePick(['v1'], 'v2', true)).toEqual(['v1', 'v2']);
    expect(togglePick(['v1', 'v2'], 'v1', true)).toEqual(['v2']);
  });

  it('reads a 409 as answered elsewhere so the page reloads the first answer', () => {
    expect(answerRefusal(new ApiError(409, 'SQ-1 Q1 is already answered (a_1 via user). The first answer stands; reload to see it.')))
      .toEqual({ message: 'SQ-1 Q1 is already answered (a_1 via user). The first answer stands; reload to see it.', answeredElsewhere: true });
    expect(answerRefusal(new ApiError(400, 'text must be a string')).answeredElsewhere).toBe(false);
    expect(answerRefusal('boom').message).toBe('Could not record the answer.');
  });

  it('posts the answer to the question endpoint with its project and surfaces the server error', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let reply: { status: number; body: unknown } = { status: 200, body: { ok: true, qid: 'q_1', delivery: 'sent' } };
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const api = new ApiClient(fetcher);

    const recorded = await api.answerQuestion('q_1', 'loadout-1', { text: 'v2' });
    expect(recorded.delivery).toBe('sent');
    expect(calls[0].url).toBe('/api/questions/q_1/answer?project=loadout-1');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ text: 'v2' });

    reply = { status: 409, body: { error: 'already answered', reason: 'already_answered' } };
    await expect(api.answerQuestion('q_1', 'loadout-1', { decline: true })).rejects.toMatchObject({ status: 409, message: 'already answered' });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ decline: true });
  });
});
