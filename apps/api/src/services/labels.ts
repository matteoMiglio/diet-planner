import type { LabelReadingDto } from '@diet/shared';
import { LABEL_SYSTEM, LABEL_USER, AiLabel } from '../ai/label-prompt.js';
import { costOf, type PlanModel } from '../ai/model.js';
import { HttpError } from '../lib/http.js';

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * Reads a nutrition label photo with the model. The photo is held in memory for the call
 * only: it is never written to disk or the database.
 */
export async function readLabel(
  model: PlanModel | null,
  image: { bytes: Uint8Array; type: string },
): Promise<LabelReadingDto> {
  if (!model)
    throw new HttpError(503, 'ai_disabled', 'Set ANTHROPIC_API_KEY on the server to read labels.');
  if (!TYPES.includes(image.type as (typeof TYPES)[number])) {
    throw new HttpError(422, 'unsupported_image', 'Send the photo as JPEG, PNG or WebP.');
  }
  if (image.bytes.byteLength === 0 || image.bytes.byteLength > MAX_BYTES) {
    throw new HttpError(413, 'too_large', 'The photo must be under 5 MB.');
  }
  const result = await model.call({
    system: LABEL_SYSTEM,
    user: LABEL_USER,
    schema: AiLabel,
    maxTokens: 4000,
    images: [
      {
        mediaType: image.type as (typeof TYPES)[number],
        data: Buffer.from(image.bytes).toString('base64'),
      },
    ],
  });
  const cost = costOf(result.served).usd;
  if (!result.output) {
    throw new HttpError(
      422,
      'unreadable_label',
      `Couldn't read the label (${result.problem ?? 'no answer'}). Try a sharper, closer photo.`,
    );
  }
  const l = result.output;
  return {
    name: l.name,
    brand: l.brand,
    servingG: l.servingG,
    per100: l.per100,
    notes: l.notes,
    costUsd: Math.round(cost * 10_000) / 10_000,
  };
}
