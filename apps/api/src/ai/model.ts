import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { z } from 'zod';

export interface ModelCall<T extends z.ZodType> {
  /** Stable instructions: cached across calls. */
  system: string;
  /** The per-request data and task. */
  user: string;
  schema: T;
  maxTokens: number;
  /** Images sent before the text, e.g. a nutrition label photo (base64, no data: prefix). */
  images?: { mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; data: string }[];
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Usage attributed to the model that actually served it (a fallback may serve part of a call). */
export interface ServedUsage {
  model: string;
  usage: ModelUsage;
}

export interface ModelResult<T> {
  /** The parsed output, or null when the model refused, was cut off or broke the schema. */
  output: T | null;
  stopReason: string | null;
  /** Why `output` is null, when it is. */
  problem: string | null;
  /** Raw text of the serving model, kept for the run log. */
  raw: string;
  served: ServedUsage[];
}

/** The one place that talks to a model; tests replace it with a fake. */
export interface PlanModel {
  readonly name: string;
  call<T extends z.ZodType>(c: ModelCall<T>): Promise<ModelResult<z.infer<T>>>;
}

export const ZERO_USAGE: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** $ per million tokens (Claude API list prices, cached 2026-10). */
const PRICES: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

/** Cost of usage served by possibly several models; `known` is false when a price is missing. */
export function costOf(served: ServedUsage[]): { usd: number; known: boolean } {
  let usd = 0;
  let known = true;
  for (const { model, usage: u } of served) {
    const p = PRICES[model];
    if (!p) {
      known = false;
      continue;
    }
    usd +=
      (u.inputTokens * p.input +
        u.outputTokens * p.output +
        u.cacheReadTokens * p.cacheRead +
        u.cacheWriteTokens * p.cacheWrite) /
      1_000_000;
  }
  return { usd, known };
}

export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** Per-model usage from the message: the iteration breakdown when present, else the total. */
function servedUsage(message: BetaMessage): ServedUsage[] {
  const iterations = message.usage.iterations ?? [];
  const perModel = iterations.flatMap((it) =>
    'model' in it && it.model
      ? [
          {
            model: String(it.model),
            usage: {
              inputTokens: it.input_tokens,
              outputTokens: it.output_tokens,
              cacheReadTokens: it.cache_read_input_tokens ?? 0,
              cacheWriteTokens: it.cache_creation_input_tokens ?? 0,
            },
          },
        ]
      : [],
  );
  if (perModel.length > 0) return perModel;
  return [
    {
      model: message.model,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
    },
  ];
}

/**
 * Turns a finished message into a result: only the text after the last fallback hop is the
 * serving model's answer, and it is parsed only when the model ended its turn normally.
 */
export function interpretMessage<T extends z.ZodType>(
  message: BetaMessage,
  schema: T,
): ModelResult<z.infer<T>> {
  // Only the content after the last fallback hop is the serving model's answer.
  const lastHop = message.content.findLastIndex((b) => b.type === 'fallback');
  const raw = message.content
    .slice(lastHop + 1)
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  const served = servedUsage(message);
  const base = { stopReason: message.stop_reason, raw, served };

  if (message.stop_reason !== 'end_turn' && message.stop_reason !== 'stop_sequence') {
    return {
      ...base,
      output: null,
      problem: `stopped with ${message.stop_reason ?? 'no reason'}`,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ...base, output: null, problem: 'the answer was not valid JSON' };
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { ...base, output: parsed.data, problem: null }
    : { ...base, output: null, problem: 'the answer did not match the schema' };
}

/** Hard limit on one model call, including the time spent streaming. */
const CALL_DEADLINE_MS = 8 * 60_000;

export function createClaudeModel(opts: {
  apiKey: string;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}): PlanModel {
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: CALL_DEADLINE_MS });
  return {
    name: opts.model,
    async call(c) {
      // The schema is sent as plain JSON schema, without the helper's parser, so the SDK never
      // parses on its own: a refusal before a fallback hop, or a truncated answer, must not
      // throw before the stop reason and usage are read.
      const { schema } = betaZodOutputFormat(c.schema);
      const abort = new AbortController();
      const deadline = setTimeout(() => abort.abort(), CALL_DEADLINE_MS);
      let message: BetaMessage;
      try {
        // Streaming keeps long generations clear of HTTP timeouts. A refused request is
        // retried server-side on Anthropic's recommended fallback model.
        const stream = client.beta.messages.stream(
          {
            model: opts.model,
            max_tokens: c.maxTokens,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            thinking: { type: 'adaptive' },
            output_config: { effort: opts.effort, format: { type: 'json_schema', schema } },
            system: [{ type: 'text', text: c.system, cache_control: { type: 'ephemeral' } }],
            messages: [
              {
                role: 'user',
                content: [
                  ...(c.images ?? []).map((img) => ({
                    type: 'image' as const,
                    source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
                  })),
                  { type: 'text' as const, text: c.user },
                ],
              },
            ],
          },
          { signal: abort.signal },
        );
        message = await stream.finalMessage();
      } catch (err) {
        if (abort.signal.aborted) {
          throw new Error(`The model did not finish within ${CALL_DEADLINE_MS / 60_000} minutes.`, {
            cause: err,
          });
        }
        throw err;
      } finally {
        clearTimeout(deadline);
      }

      return interpretMessage(message, c.schema);
    },
  };
}
