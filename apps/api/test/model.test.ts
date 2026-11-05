import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { costOf, interpretMessage } from '../src/ai/model.js';

const Schema = z.object({ answer: z.number() });

/** A finished message, as the SDK hands it over; only the fields the code reads matter. */
function message(content: unknown[], stop: string, usage: object = {}): BetaMessage {
  return {
    model: 'claude-opus-5-5',
    stop_reason: stop,
    content,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      iterations: null,
      ...usage,
    },
  } as unknown as BetaMessage;
}

describe('interpretMessage', () => {
  it('parses a normal answer', () => {
    const r = interpretMessage(
      message([{ type: 'text', text: '{"answer": 4}' }], 'end_turn'),
      Schema,
    );
    expect(r).toMatchObject({ output: { answer: 4 }, problem: null });
  });

  it('reads only what follows the last fallback hop', () => {
    const r = interpretMessage(
      message(
        [
          { type: 'text', text: "I can't help with that." },
          {
            type: 'fallback',
            from: { model: 'claude-opus-5-5' },
            to: { model: 'claude-opus-4-8' },
            trigger: {},
          },
          { type: 'text', text: '{"answer": 7}' },
        ],
        'end_turn',
        {
          iterations: [
            {
              type: 'message',
              model: 'claude-opus-5-5',
              input_tokens: 100,
              output_tokens: 5,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            {
              type: 'fallback_message',
              model: 'claude-opus-4-8',
              input_tokens: 100,
              output_tokens: 50,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          ],
        },
      ),
      Schema,
    );
    expect(r.output).toEqual({ answer: 7 });
    expect(r.served.map((s) => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-4-8']);
  });

  it('keeps usage and explains a truncated answer instead of throwing', () => {
    const r = interpretMessage(
      message([{ type: 'text', text: '{"answer": ' }], 'max_tokens'),
      Schema,
    );
    expect(r).toMatchObject({ output: null, problem: 'stopped with max_tokens' });
    expect(r.served[0]?.usage.inputTokens).toBe(100);
  });

  it('reports invalid JSON and schema mismatches', () => {
    expect(
      interpretMessage(message([{ type: 'text', text: 'nope' }], 'end_turn'), Schema).problem,
    ).toBe('the answer was not valid JSON');
    expect(
      interpretMessage(message([{ type: 'text', text: '{"answer":"x"}' }], 'end_turn'), Schema)
        .problem,
    ).toBe('the answer did not match the schema');
  });
});

describe('costOf', () => {
  it('prices each serving model and flags unknown ones', () => {
    const u = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costOf([{ model: 'claude-opus-5-5', usage: u }])).toEqual({ usd: 4, known: true });
    expect(
      costOf([
        { model: 'claude-opus-5-5', usage: u },
        { model: 'mystery-1', usage: u },
      ]),
    ).toEqual({ usd: 4, known: false });
  });
});
