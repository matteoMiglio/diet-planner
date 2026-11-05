/**
 * Parser for the CSV export of the My Tanita app (verified against an RD-953 export).
 *
 * Columns are matched by header name, not position, through an alias table, so a reordered
 * or Italian-language export still parses. Segmental columns (per-limb fat and muscle) are
 * always empty in RD-953 exports; they, and any unknown column, are kept only in `raw`.
 *
 * Dates are local wall-clock times with no zone (`YYYY-MM-DD HH:MM:SS`); converting them to
 * instants is the caller's job, because it needs the user's timezone.
 */

export interface TanitaRow {
  /** 1-based line number in the file, for error messages. */
  line: number;
  /** Local wall-clock time as `YYYY-MM-DDTHH:MM:SS`. */
  localDateTime: string;
  weightKg: number;
  bmi: number | null;
  bodyFatPct: number | null;
  muscleMassKg: number | null;
  muscleQuality: number | null;
  boneMassKg: number | null;
  visceralFat: number | null;
  bmrKcal: number | null;
  metabolicAge: number | null;
  bodyWaterPct: number | null;
  physiqueRating: number | null;
  /** The original row, keyed by header, for re-parsing later. */
  raw: Record<string, string>;
}

export interface TanitaParseError {
  line: number;
  message: string;
}

export interface TanitaParseResult {
  rows: TanitaRow[];
  errors: TanitaParseError[];
  /** Headers not mapped to a field (kept in `raw`). */
  unmappedColumns: string[];
}

type Field = Exclude<keyof TanitaRow, 'line' | 'localDateTime' | 'raw'> | 'date' | 'weightLb';

/** Normalised header → field. Normalisation: lowercase, accents and punctuation stripped. */
const ALIASES: Record<string, Field> = {
  date: 'date',
  data: 'date',
  'weight kg': 'weightKg',
  weight: 'weightKg',
  'peso kg': 'weightKg',
  peso: 'weightKg',
  'weight lb': 'weightLb',
  'peso lb': 'weightLb',
  bmi: 'bmi',
  imc: 'bmi',
  'body fat': 'bodyFatPct',
  'grasso corporeo': 'bodyFatPct',
  'massa grassa': 'bodyFatPct',
  'visc fat': 'visceralFat',
  'visceral fat': 'visceralFat',
  'grasso viscerale': 'visceralFat',
  'muscle mass kg': 'muscleMassKg',
  'muscle mass': 'muscleMassKg',
  'massa muscolare kg': 'muscleMassKg',
  'massa muscolare': 'muscleMassKg',
  'muscle quality': 'muscleQuality',
  'qualita muscolare': 'muscleQuality',
  'bone mass kg': 'boneMassKg',
  'bone mass': 'boneMassKg',
  'massa ossea kg': 'boneMassKg',
  'massa ossea': 'boneMassKg',
  'bmr kcal': 'bmrKcal',
  bmr: 'bmrKcal',
  'metabolismo basale kcal': 'bmrKcal',
  'metab age': 'metabolicAge',
  'metabolic age': 'metabolicAge',
  'eta metabolica': 'metabolicAge',
  'body water': 'bodyWaterPct',
  'acqua corporea': 'bodyWaterPct',
  'physique rating': 'physiqueRating',
  'valutazione fisico': 'physiqueRating',
  'costituzione fisica': 'physiqueRating',
};

/** Plausible ranges; values outside them are treated as a broken row, not stored. */
const RANGES: Partial<Record<Field, [number, number]>> = {
  weightKg: [20, 300],
  bmi: [8, 80],
  bodyFatPct: [1, 75],
  muscleMassKg: [5, 150],
  muscleQuality: [0, 100],
  boneMassKg: [0.5, 10],
  visceralFat: [1, 59],
  bmrKcal: [500, 6000],
  metabolicAge: [5, 120],
  bodyWaterPct: [20, 80],
  physiqueRating: [1, 9],
};

const INTEGER_FIELDS = new Set<Field>(['bmrKcal', 'metabolicAge', 'physiqueRating']);
const LB_TO_KG = 0.45359237;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

export function normaliseHeader(header: string): string {
  return header
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export class CsvError extends Error {}

/** Minimal RFC 4180 CSV reader: quoted fields, escaped quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (quoted) throw new CsvError('A quoted field is never closed: the file looks cut off.');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0]?.trim() === ''));
}

/** `Date` silently rolls 2026-02-30 over to March; round-trip to reject impossible dates. */
function isRealDateTime(localDateTime: string): boolean {
  const d = new Date(`${localDateTime}Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 19) === localDateTime;
}

function parseNumber(value: string): number | null {
  const v = value.trim();
  if (v === '' || v === '-' || v === '--') return null;
  // Tolerate a decimal comma from a localised export.
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

export function parseTanitaCsv(text: string): TanitaParseResult {
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (err) {
    if (err instanceof CsvError)
      return { rows: [], errors: [{ line: 1, message: err.message }], unmappedColumns: [] };
    throw err;
  }
  const errors: TanitaParseError[] = [];
  const header = table[0];
  if (!header)
    return { rows: [], errors: [{ line: 1, message: 'The file is empty.' }], unmappedColumns: [] };

  const columns = header.map((h) => ({ name: h.trim(), field: ALIASES[normaliseHeader(h)] }));
  const unmappedColumns = columns.filter((c) => !c.field).map((c) => c.name);
  const mapped = new Set(columns.map((c) => c.field));
  if (!mapped.has('date')) {
    return {
      rows: [],
      errors: [{ line: 1, message: 'No date column found. Is this a My Tanita export?' }],
      unmappedColumns,
    };
  }
  if (!mapped.has('weightKg') && !mapped.has('weightLb')) {
    return {
      rows: [],
      errors: [{ line: 1, message: 'No weight column found. Is this a My Tanita export?' }],
      unmappedColumns,
    };
  }

  const rows: TanitaRow[] = [];
  table.slice(1).forEach((cells, index) => {
    const line = index + 2;
    if (cells.length > columns.length) {
      errors.push({
        line,
        message: `Has ${cells.length} values but the header has ${columns.length} columns`,
      });
      return;
    }
    const raw: Record<string, string> = {};
    const values: Partial<Record<Field, number | null>> = {};
    let dateText = '';
    const problems: string[] = [];

    columns.forEach((col, i) => {
      const cell = cells[i] ?? '';
      raw[col.name] = cell;
      if (!col.field) return;
      if (col.field === 'date') {
        dateText = cell.trim();
        return;
      }
      const n = parseNumber(cell);
      if (Number.isNaN(n)) problems.push(`"${col.name}" is not a number ("${cell}")`);
      else values[col.field] = n;
    });

    const m = DATE_RE.exec(dateText);
    if (!m) {
      errors.push({ line, message: `Unrecognised date "${dateText}"` });
      return;
    }
    const localDateTime = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}`;
    if (!isRealDateTime(localDateTime)) {
      errors.push({ line, message: `Invalid date "${dateText}"` });
      return;
    }

    if (values.weightKg == null && values.weightLb != null) {
      values.weightKg = Math.round(values.weightLb * LB_TO_KG * 100) / 100;
    }
    for (const [field, [lo, hi]] of Object.entries(RANGES) as [Field, [number, number]][]) {
      const v = values[field];
      if (v != null && (v < lo || v > hi)) problems.push(`${field} ${v} is outside ${lo}–${hi}`);
      if (v != null && INTEGER_FIELDS.has(field)) values[field] = Math.round(v);
    }
    if (values.weightKg == null) problems.push('weight is missing');
    if (problems.length > 0) {
      errors.push({ line, message: problems.join('; ') });
      return;
    }

    rows.push({
      line,
      localDateTime,
      weightKg: values.weightKg!,
      bmi: values.bmi ?? null,
      bodyFatPct: values.bodyFatPct ?? null,
      muscleMassKg: values.muscleMassKg ?? null,
      muscleQuality: values.muscleQuality ?? null,
      boneMassKg: values.boneMassKg ?? null,
      visceralFat: values.visceralFat ?? null,
      bmrKcal: values.bmrKcal ?? null,
      metabolicAge: values.metabolicAge ?? null,
      bodyWaterPct: values.bodyWaterPct ?? null,
      physiqueRating: values.physiqueRating ?? null,
      raw,
    });
  });

  return { rows, errors, unmappedColumns };
}
