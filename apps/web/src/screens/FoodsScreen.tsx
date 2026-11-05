import type { FoodDto, FoodInput } from '@diet/shared';
import { Plus, Search, X } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError } from '../api';
import { ScreenHeader } from '../components/ScreenHeader';
import { Button, Card, ErrorNote, NumberField, parseDecimal } from '../components/ui';
import { useQuery } from '../useQuery';

export function FoodsScreen() {
  const foods = useQuery<FoodDto[]>('/foods?archived=1');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<FoodDto | 'new' | null>(null);

  const needle = q.trim().toLowerCase();
  const shown = (foods.data ?? []).filter(
    (f) =>
      !needle || f.name.toLowerCase().includes(needle) || f.brand?.toLowerCase().includes(needle),
  );
  const active = shown.filter((f) => !f.archived);
  const archived = shown.filter((f) => f.archived);

  return (
    <>
      <div className="flex items-start justify-between">
        <ScreenHeader title="Foods">Values per 100 g, as on the label.</ScreenHeader>
        <Button variant="ghost" className="-mr-2" onClick={() => setEditing('new')}>
          <Plus size={18} aria-hidden /> Add
        </Button>
      </div>

      <label className="mb-4 flex items-center gap-2 rounded-xl border border-border bg-surface px-3">
        <Search size={16} className="text-muted" aria-hidden />
        <span className="sr-only">Search foods</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          className="min-h-11 flex-1 bg-transparent text-base outline-none"
        />
      </label>

      {foods.status === 'error' && <ErrorNote>{foods.error.message}</ErrorNote>}
      {foods.data && foods.data.length === 0 && (
        <p className="text-sm text-muted">No foods yet. Add the ones your plan uses.</p>
      )}
      <FoodList foods={active} onPick={setEditing} />
      {archived.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-muted">
            Archived ({archived.length})
          </summary>
          <FoodList foods={archived} onPick={setEditing} />
        </details>
      )}

      {editing && (
        <FoodSheet
          food={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void foods.reload();
          }}
        />
      )}
    </>
  );
}

function FoodList({ foods, onPick }: { foods: FoodDto[]; onPick: (f: FoodDto) => void }) {
  if (foods.length === 0) return null;
  return (
    <Card className="p-0">
      <ul className="divide-y divide-border">
        {foods.map((f) => (
          <li key={f.id}>
            <button
              type="button"
              onClick={() => onPick(f)}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-surface-2"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{f.name}</span>
                {f.brand && <span className="block truncate text-xs text-muted">{f.brand}</span>}
              </span>
              <span className="shrink-0 text-right text-xs text-muted">
                <span className="block font-medium text-text">{Math.round(f.kcal)} kcal</span>P{' '}
                {f.proteinG} · C {f.carbsG} · F {f.fatG}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const BASES: { value: FoodDto['basis']; label: string }[] = [
  { value: 'as_sold', label: 'As sold' },
  { value: 'raw', label: 'Raw' },
  { value: 'dry', label: 'Dry' },
  { value: 'cooked', label: 'Cooked' },
  { value: 'drained', label: 'Drained' },
];

const text = (v: number | null | undefined) => (v == null ? '' : String(v));

function FoodSheet({
  food,
  onClose,
  onSaved,
}: {
  food: FoodDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(food?.name ?? '');
  const [brand, setBrand] = useState(food?.brand ?? '');
  const [kcal, setKcal] = useState(text(food?.kcal));
  const [protein, setProtein] = useState(text(food?.proteinG));
  const [carbs, setCarbs] = useState(text(food?.carbsG));
  const [fat, setFat] = useState(text(food?.fatG));
  const [fibre, setFibre] = useState(text(food?.fibreG));
  const [basis, setBasis] = useState<FoodDto['basis']>(food?.basis ?? 'as_sold');
  const [units, setUnits] = useState(
    Object.entries(food?.units ?? {}).map(([unit, grams]) => ({ unit, grams: String(grams) })),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(archived?: boolean) {
    setError(null);
    const nums = [kcal, protein, carbs, fat].map(parseDecimal);
    if (nums.some((n) => n == null))
      return setError('Energy, protein, carbs and fat are required numbers.');
    const fib = parseDecimal(fibre);
    if (fib === undefined) return setError('Fibre must be a number (or empty).');
    const unitMap: Record<string, number> = {};
    for (const u of units) {
      if (!u.unit.trim()) continue;
      const g = parseDecimal(u.grams);
      if (g == null || g <= 0) return setError(`"${u.unit}" needs a weight in grams.`);
      unitMap[u.unit.trim()] = g;
    }
    const body: FoodInput = {
      name: name.trim(),
      brand: brand.trim() || null,
      kcal: nums[0]!,
      proteinG: nums[1]!,
      carbsG: nums[2]!,
      fatG: nums[3]!,
      fibreG: fib,
      basis,
      units: unitMap,
      ...(archived !== undefined && { archived }),
    };
    if (!body.name) return setError('Give the food a name.');
    setSaving(true);
    try {
      if (food) await api.patch(`/foods/${food.id}`, body);
      else await api.post('/foods', body);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-20 flex items-end justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="food-title"
    >
      <form
        className="max-h-[90vh] w-full max-w-xl space-y-3 overflow-y-auto rounded-t-3xl bg-surface p-5 pb-[max(env(safe-area-inset-bottom),1.25rem)]"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex items-center justify-between">
          <h2 id="food-title" className="text-lg font-bold">
            {food ? 'Edit food' : 'New food'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-2 text-muted hover:bg-surface-2"
          >
            <X size={20} aria-hidden />
          </button>
        </div>
        <TextRow label="Name" value={name} onChange={setName} />
        <TextRow label="Brand" value={brand} onChange={setBrand} />
        <p className="pt-2 text-xs font-semibold tracking-wide text-muted uppercase">Per 100 g</p>
        <NumberField label="Energy" unit="kcal" value={kcal} onChange={setKcal} />
        <NumberField label="Protein" unit="g" value={protein} onChange={setProtein} />
        <NumberField label="Carbs" unit="g" value={carbs} onChange={setCarbs} />
        <NumberField label="Fat" unit="g" value={fat} onChange={setFat} />
        <NumberField label="Fibre" unit="g" value={fibre} onChange={setFibre} />
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm">Values refer to</span>
          <select
            value={basis}
            onChange={(e) => setBasis(e.target.value as FoodDto['basis'])}
            className="rounded-xl border border-border bg-bg px-3 py-2 text-base"
          >
            {BASES.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </label>

        <p className="pt-2 text-xs font-semibold tracking-wide text-muted uppercase">Portions</p>
        {units.map((u, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              aria-label="Portion name"
              placeholder="cup, slice, pcs…"
              value={u.unit}
              onChange={(e) =>
                setUnits(units.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))
              }
              className="min-h-10 flex-1 rounded-xl border border-border bg-bg px-3 text-base"
            />
            <input
              aria-label="Grams per portion"
              inputMode="decimal"
              placeholder="g"
              value={u.grams}
              onChange={(e) =>
                setUnits(units.map((x, j) => (j === i ? { ...x, grams: e.target.value } : x)))
              }
              className="min-h-10 w-20 rounded-xl border border-border bg-bg px-3 text-right text-base"
            />
            <span className="text-sm text-muted">g</span>
            <button
              type="button"
              aria-label="Remove portion"
              onClick={() => setUnits(units.filter((_, j) => j !== i))}
              className="rounded-full p-2 text-muted hover:bg-surface-2"
            >
              <X size={16} aria-hidden />
            </button>
          </div>
        ))}
        <Button variant="ghost" onClick={() => setUnits([...units, { unit: '', grams: '' }])}>
          <Plus size={16} aria-hidden /> Add a portion
        </Button>

        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex gap-2 pt-2">
          <Button type="submit" disabled={saving} className="flex-1">
            {saving ? 'Saving…' : 'Save'}
          </Button>
          {food && (
            <Button variant="secondary" disabled={saving} onClick={() => void save(!food.archived)}>
              {food.archived ? 'Restore' : 'Archive'}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

function TextRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-sm">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-10 w-56 rounded-xl border border-border bg-bg px-3 text-base outline-none focus:border-accent"
      />
    </label>
  );
}
