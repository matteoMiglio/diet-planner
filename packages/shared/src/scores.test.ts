import { describe, expect, it } from 'vitest';
import { fitScore, nutriScore, qualityScore } from './scores.js';
import type { FitInput, NutriInput, QualityInput, ScorePart } from './scores.js';

const nutrients: NutriInput = {
  kcal: 0,
  sugarsG: 0,
  satFatG: 0,
  saltG: 0,
  fibreG: 0,
  proteinG: 0,
};
const quality: QualityInput = {
  nutriscoreGrade: null,
  computed: null,
  novaGroup: null,
  additives: null,
};
const food: FitInput = {
  per100: { kcal: 200, proteinG: 20, carbsG: 20, fatG: 4 },
  portionG: 100,
  role: 'main_protein',
  phase: 'maintenance',
  remaining: { kcal: 400, fatG: 20 },
  slot: 'lunch',
  slotRoles: ['main_protein'],
  ruleConflicts: [],
};

function value(parts: ScorePart[], key: string): number | null {
  const part = parts.find((part) => part.key === key);
  expect(part).toBeDefined();
  return part!.value;
}

describe('nutriScore', () => {
  it('scores plain 0% Greek yogurt A', () => {
    // 59 kcal = 246.856 kJ: energy 0 + sugar 1 + sat fat 0 + salt 0
    // minus protein 4 (10.3 g) = -3.
    expect(
      nutriScore({ ...nutrients, kcal: 59, sugarsG: 3.6, proteinG: 10.3, saltG: 0.1 }),
    ).toEqual({ points: -3, grade: 'a', complete: true });
  });

  it('scores a Nutella-like spread E', () => {
    // 539 kcal = 2255.176 kJ: energy 6 + sugar 15 + sat fat 10 + salt 0
    // = 31; no fibre credit and protein ignored because N >= 11.
    expect(
      nutriScore({
        ...nutrients,
        kcal: 539,
        sugarsG: 56.3,
        satFatG: 10.6,
        saltG: 0.107,
        proteinG: 6.3,
      }),
    ).toEqual({ points: 31, grade: 'e', complete: true });
  });

  it('scores rolled oats A', () => {
    // 370 kcal = 1548.08 kJ: energy 4 + sugar 0 + sat fat 1 + salt 0
    // minus fibre 5 (10 g) and protein 5 (13 g) = -5.
    expect(
      nutriScore({ kcal: 370, sugarsG: 1, satFatG: 1.3, saltG: 0.01, fibreG: 10, proteinG: 13 }),
    ).toEqual({ points: -5, grade: 'a', complete: true });
  });

  it('counts protein below 11 negative points but ignores it at 11, even with fruit credit', () => {
    expect(nutriScore({ ...nutrients, saltG: 2.1, proteinG: 20 }).points).toBe(3);
    expect(nutriScore({ ...nutrients, saltG: 2.3, proteinG: 20 }).points).toBe(11);
    expect(
      nutriScore({ ...nutrients, saltG: 2.3, proteinG: 20, fruitVegPct: 100, fibreG: 10 }).points,
    ).toBe(1);
  });

  it.each(['sugarsG', 'satFatG', 'saltG'] as const)(
    'marks missing %s incomplete and treats it as zero',
    (key) => {
      expect(nutriScore({ ...nutrients, [key]: null })).toEqual({
        points: 0,
        grade: 'a',
        complete: false,
      });
    },
  );

  it('does not mark missing fibre or fruit incomplete', () => {
    expect(nutriScore({ ...nutrients, fibreG: null, fruitVegPct: null })).toEqual({
      points: 0,
      grade: 'a',
      complete: true,
    });
  });

  it.each([
    ['sugarsG', 3.4, 0],
    ['sugarsG', 3.4001, 1],
    ['sugarsG', 51, 14],
    ['sugarsG', 51.01, 15],
    ['satFatG', 10, 9],
    ['satFatG', 10.01, 10],
    ['saltG', 4, 19],
    ['saltG', 4.01, 20],
    ['fibreG', 3, 0],
    ['fibreG', 3.01, -1],
    ['fibreG', 7.4, -4],
    ['fibreG', 7.41, -5],
    ['proteinG', 17, -6],
    ['proteinG', 17.01, -7],
    ['fruitVegPct', 40, 0],
    ['fruitVegPct', 40.01, -1],
    ['fruitVegPct', 60, -1],
    ['fruitVegPct', 60.01, -2],
    ['fruitVegPct', 80, -2],
    ['fruitVegPct', 80.01, -5],
  ] as const)('uses strict thresholds for %s = %s', (key, amount, points) => {
    expect(nutriScore({ ...nutrients, [key]: amount }).points).toBe(points);
  });

  it('converts kcal to kJ and caps energy at ten points', () => {
    expect(nutriScore({ ...nutrients, kcal: 80 }).points).toBe(0);
    expect(nutriScore({ ...nutrients, kcal: 81 }).points).toBe(1);
    expect(nutriScore({ ...nutrients, kcal: 1000 }).points).toBe(10);
  });

  it.each([
    [0, 'a'],
    [1, 'b'],
    [2, 'b'],
    [3, 'c'],
    [10, 'c'],
    [11, 'd'],
    [18, 'd'],
    [19, 'e'],
  ] as const)('grades %s points as %s', (points, grade) => {
    const result = nutriScore({ ...nutrients, saltG: points * 0.2 + 0.01 });
    expect(result.points).toBe(points);
    expect(result.grade).toBe(grade);
  });
});

describe('qualityScore', () => {
  it('prefers an OFF grade to a computed grade and names the source', () => {
    const result = qualityScore({
      ...quality,
      nutriscoreGrade: 'e',
      computed: nutriScore(nutrients),
      novaGroup: 1,
      additives: [],
    });
    expect(result.score).toBe(40);
    expect(result.band).toBe('poor');
    expect(result.parts[0]?.detail).toContain('Open Food Facts Nutri-Score: E');
  });

  it.each(['unknown', 'not-applicable', null])(
    'falls back from %s to the computed grade',
    (nutriscoreGrade) => {
      const result = qualityScore({
        ...quality,
        nutriscoreGrade,
        computed: { points: 1, grade: 'b', complete: true },
      });
      expect(result.score).toBe(75);
      expect(result.parts[0]?.detail).toContain('Computed Nutri-Score: B');
    },
  );

  it('renormalises missing NOVA while keeping nominal weights in the parts', () => {
    // (50 * 60 + 100 * 15) / (60 + 15) = 60.
    const result = qualityScore({ ...quality, nutriscoreGrade: 'c', additives: [] });
    expect(result).toMatchObject({ score: 60, band: 'ok', partial: false });
    expect(value(result.parts, 'processing')).toBeNull();
    expect(result.parts.map((part) => part.weight)).toEqual([60, 25, 15]);
  });

  it('leaves a partial result unbanded and an empty result unscored', () => {
    expect(qualityScore({ ...quality, additives: [] })).toMatchObject({
      score: 100,
      band: null,
      partial: true,
    });
    expect(qualityScore(quality)).toMatchObject({ score: null, band: null, partial: true });
  });

  it('floors additives at zero and distinguishes empty from unknown', () => {
    expect(qualityScore({ ...quality, additives: ['a', 'b'] }).score).toBe(70);
    expect(
      qualityScore({ ...quality, additives: Array.from({ length: 8 }, (_, i) => `e${i}`) }).score,
    ).toBe(0);
    expect(value(qualityScore(quality).parts, 'additives')).toBeNull();
    expect(qualityScore({ ...quality, additives: [] }).score).toBe(100);
  });

  it.each([
    [1, 100],
    [2, 75],
    [3, 50],
    [4, 15],
    [0, null],
    [5, null],
    [1.5, null],
  ] as const)('maps NOVA %s to %s', (novaGroup, score) => {
    expect(qualityScore({ ...quality, novaGroup }).score).toBe(score);
  });

  it.each([
    ['a', 'good'],
    ['b', 'ok'],
    ['c', 'poor'],
    ['d', 'avoid'],
    ['e', 'avoid'],
  ] as const)('bands grade %s with NOVA 4', (nutriscoreGrade, band) => {
    // A: 75, B: 57, C: 40, D: 22, E: 4 after rounding.
    const result = qualityScore({ ...quality, nutriscoreGrade, novaGroup: 4 });
    expect(result.band).toBe(band);
  });
});

describe('fitScore', () => {
  it.each([
    ['cut', [40, 30, 0, 15, 15]],
    ['maintenance', [30, 30, 10, 15, 15]],
    ['maingain', [30, 30, 10, 15, 15]],
    ['recomp', [30, 30, 10, 15, 15]],
    [null, [30, 30, 10, 15, 15]],
    ['surplus', [20, 15, 35, 15, 15]],
  ] as const)('uses weights summing to 100 for %s', (phase, weights) => {
    const parts = fitScore({ ...food, phase }).parts;
    expect(parts.map((part) => part.weight)).toEqual(weights);
    expect(parts.reduce((sum, part) => sum + part.weight, 0)).toBe(100);
  });

  it('favours energy-dense foods in surplus and protein density in a cut', () => {
    const dense: FitInput = { ...food, per100: { kcal: 400, proteinG: 10, carbsG: 70, fatG: 8 } };
    const lean: FitInput = { ...food, per100: { kcal: 100, proteinG: 10, carbsG: 10, fatG: 2 } };
    expect(fitScore({ ...dense, phase: 'surplus' }).score).toBeGreaterThan(
      fitScore({ ...lean, phase: 'surplus' }).score,
    );
    expect(fitScore({ ...dense, phase: 'cut' }).score).toBeLessThan(
      fitScore({ ...lean, phase: 'cut' }).score,
    );
    expect(value(fitScore(dense).parts, 'closes_gap')).toBe(100);
    expect(value(fitScore(lean).parts, 'closes_gap')).toBe(25);
  });

  it.each([
    [100, 100],
    [150, 50],
    [200, 0],
    [300, 0],
  ])('scales a %s g portion to budget fit %s', (portionG, expected) => {
    const result = fitScore({ ...food, portionG, remaining: { kcal: 200, fatG: 100 } });
    expect(value(result.parts, 'fits_today')).toBe(expected);
  });

  it('uses the more restrictive fat or calorie budget', () => {
    const result = fitScore({ ...food, remaining: { kcal: 500, fatG: 8 / 3 } });
    expect(value(result.parts, 'fits_today')).toBeCloseTo(50);
    expect(result.reasons).toContain("Would go 1 g fat over today's budget.");
  });

  it.each([0, -100])('handles a remaining calorie budget of %s', (kcal) => {
    const result = fitScore({ ...food, remaining: { kcal, fatG: 0 } });
    expect(value(result.parts, 'fits_today')).toBe(0);
    expect(value(result.parts, 'closes_gap')).toBe(0);
    expect(Number.isFinite(result.score)).toBe(true);
  });

  it('renormalises unknown remaining budgets', () => {
    // Protein 100 * 30 + neutral slot 50 * 15 + no conflicts 100 * 15,
    // divided by 60 available weight = 87.5 -> 88.
    const result = fitScore({ ...food, remaining: null, role: null });
    expect(result.score).toBe(88);
    expect(value(result.parts, 'fits_today')).toBeNull();
    expect(value(result.parts, 'closes_gap')).toBeNull();
    expect(result.reasons).toEqual(['High protein: 10 g per 100 kcal.']);
  });

  it('handles zero energy and zero budgets without NaN', () => {
    const result = fitScore({
      ...food,
      per100: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 },
      remaining: { kcal: 0, fatG: 0 },
    });
    expect(value(result.parts, 'protein_density')).toBe(0);
    expect(value(result.parts, 'fits_today')).toBe(100);
    expect(value(result.parts, 'closes_gap')).toBe(0);
    expect(Number.isFinite(result.score)).toBe(true);
  });

  it('drops the score for conflicts and puts the conflict reason first', () => {
    const normal = fitScore(food);
    const conflicted = fitScore({ ...food, ruleConflicts: ['a second Huel product today'] });
    expect(normal.score - conflicted.score).toBe(15);
    expect(conflicted.reasons[0]).toBe('Clashes with your rules: a second Huel product today.');
    expect(conflicted.reasons.length).toBeLessThanOrEqual(4);
  });

  it('explains calorie overages and successful budget fits', () => {
    expect(fitScore({ ...food, remaining: { kcal: 50, fatG: 100 } }).reasons[0]).toBe(
      "Would go 150 kcal over today's budget.",
    );
    expect(fitScore(food).reasons).toContain("Fits today's budget (200 of 400 kcal left).");
  });

  it('scores matching, unknown and mismatched roles', () => {
    expect(value(fitScore(food).parts, 'slot_fit')).toBe(100);
    expect(value(fitScore({ ...food, role: null }).parts, 'slot_fit')).toBe(50);
    expect(value(fitScore({ ...food, slotRoles: [] }).parts, 'slot_fit')).toBe(50);
    expect(value(fitScore({ ...food, role: 'fruit' }).parts, 'slot_fit')).toBe(20);
  });

  it('is deterministic and does not mutate inputs', () => {
    const before = structuredClone(food);
    expect(fitScore(food)).toEqual(fitScore(food));
    expect(food).toEqual(before);
    expect(nutriScore(nutrients)).toEqual(nutriScore(nutrients));
    expect(qualityScore(quality)).toEqual(qualityScore(quality));
    expect(nutrients).toEqual({
      kcal: 0,
      sugarsG: 0,
      satFatG: 0,
      saltG: 0,
      fibreG: 0,
      proteinG: 0,
    });
  });
});

describe('review fixes', () => {
  const lean = { kcal: 200, sugarsG: 0, satFatG: 4, saltG: 0.1, fibreG: 0, proteinG: 20 };

  it('caps protein for red meat at 2 points', () => {
    expect(nutriScore(lean).grade).toBe('a');
    expect(nutriScore({ ...lean, category: 'red_meat' }).grade).toBe('c');
  });

  it('keeps protein credit for cheese even at 11+ negative points', () => {
    const cheese = { kcal: 400, sugarsG: 0, satFatG: 20, saltG: 1.6, fibreG: 0, proteinG: 25 };
    expect(nutriScore(cheese).points).toBeGreaterThan(
      nutriScore({ ...cheese, category: 'cheese' }).points,
    );
  });

  it('does not band a product whose computed nutrition is incomplete', () => {
    const computed = nutriScore({
      kcal: 200,
      sugarsG: null,
      satFatG: null,
      saltG: null,
      fibreG: null,
      proteinG: 10,
    });
    const q = qualityScore({ nutriscoreGrade: null, computed, novaGroup: 4, additives: [] });
    expect(q.parts.find((p) => p.key === 'nutrition')?.value).toBeNull();
    expect(q.parts.find((p) => p.key === 'nutrition')?.detail).toContain('Not enough data');
  });
});
