import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normaliseHeader, parseCsv, parseTanitaCsv } from './tanita.js';

// Same header and empty-segment layout as a real RD-953 export; the values are made up.
const fixture = readFileSync(
  new URL('../test/fixtures/tanita-rd953-synthetic.csv', import.meta.url),
  'utf8',
);

describe('parseTanitaCsv with an RD-953 export', () => {
  const result = parseTanitaCsv(fixture);

  it('parses every row without errors', () => {
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(3);
  });

  it('maps the composition columns and keeps local time', () => {
    expect(result.rows[0]).toMatchObject({
      line: 2,
      localDateTime: '2026-01-12T07:41:10',
      weightKg: 80.4,
      bmi: 24.1,
      bodyFatPct: 15.2,
      visceralFat: 4,
      muscleMassKg: 64.5,
      muscleQuality: 70,
      boneMassKg: 3.3,
      bmrKcal: 1950,
      metabolicAge: 24,
      bodyWaterPct: 56.1,
      physiqueRating: 5,
    });
  });

  it('leaves the empty segmental columns out of the fields but keeps them raw', () => {
    expect(result.unmappedColumns).toContain('Muscle mass - right arm');
    expect(result.unmappedColumns).toContain('Heart rate');
    expect(result.rows[0]?.raw['Muscle quality - right arm']).toBe('0.00');
    expect(result.rows[0]?.raw['Body fat (%) - trunk']).toBe('-');
  });
});

describe('parseTanitaCsv robustness', () => {
  it('matches columns by name, in any order and in Italian', () => {
    const csv =
      'Peso (kg),Data,Grasso corporeo (%),Età metabolica\n81.2,2026-03-01 07:00:00,14.0,22\n';
    const { rows, errors } = parseTanitaCsv(csv);
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({
      localDateTime: '2026-03-01T07:00:00',
      weightKg: 81.2,
      bodyFatPct: 14,
      metabolicAge: 22,
    });
  });

  it('converts pounds to kilograms', () => {
    const { rows } = parseTanitaCsv('Date,Weight (lb)\n2026-03-01 07:00:00,180\n');
    expect(rows[0]?.weightKg).toBe(81.65);
  });

  it('treats "-" as missing and tolerates a decimal comma', () => {
    const { rows } = parseTanitaCsv('Date,Weight (kg),Body Fat (%)\n2026-03-01 07:00,"80,5",-\n');
    expect(rows[0]).toMatchObject({
      weightKg: 80.5,
      bodyFatPct: null,
      localDateTime: '2026-03-01T07:00:00',
    });
  });

  it('reports broken rows by line and keeps the good ones', () => {
    const csv = [
      'Date,Weight (kg),Body Fat (%)',
      '2026-03-01 07:00:00,80.5,14',
      'yesterday,80.5,14',
      '2026-03-03 07:00:00,abc,14',
      '2026-03-04 07:00:00,8000,14',
      '2026-02-30 07:00:00,80,14',
      '2026-03-05 07:00:00,,14',
      '2026-03-06 07:00:00,80.1,14',
    ].join('\r\n');
    const { rows, errors } = parseTanitaCsv(csv);
    expect(rows.map((r) => r.line)).toEqual([2, 8]);
    expect(errors.map((e) => e.line)).toEqual([3, 4, 5, 6, 7]);
    expect(errors[0]?.message).toContain('Unrecognised date');
    expect(errors[2]?.message).toContain('outside');
  });

  it('rejects files without a date or weight column', () => {
    expect(parseTanitaCsv('Foo,Bar\n1,2\n').errors[0]?.message).toContain('No date column');
    expect(parseTanitaCsv('Date,Bar\n2026-03-01 07:00:00,2\n').errors[0]?.message).toContain(
      'No weight column',
    );
    expect(parseTanitaCsv('').errors[0]?.message).toContain('empty');
  });
});

describe('malformed files', () => {
  it('rejects rows with more values than columns instead of guessing', () => {
    // "80,5" written with a decimal comma but unquoted: two cells, not 80.5.
    const { rows, errors } = parseTanitaCsv('Date,Weight (kg)\n2026-03-01 07:00:00,80,5\n');
    expect(rows).toEqual([]);
    expect(errors[0]).toMatchObject({ line: 2, message: expect.stringContaining('3 values') });
  });

  it('rejects a file cut off inside a quoted field', () => {
    const { rows, errors } = parseTanitaCsv('Date,Weight (kg)\n"2026-03-01 07:00:00,80\n');
    expect(rows).toEqual([]);
    expect(errors[0]?.message).toContain('never closed');
  });
});

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, CRLF, a BOM and a trailing newline', () => {
    expect(parseCsv('﻿a,"b,c","d ""e"""\r\n1,2,3\n')).toEqual([
      ['a', 'b,c', 'd "e"'],
      ['1', '2', '3'],
    ]);
  });
});

describe('normaliseHeader', () => {
  it('strips units punctuation and accents', () => {
    expect(normaliseHeader('"Body Fat (%)"')).toBe('body fat');
    expect(normaliseHeader('Età metabolica')).toBe('eta metabolica');
  });
});
