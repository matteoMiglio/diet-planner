import type { FoodDto, FoodInput, PoolInfo, Slot } from '@diet/shared';
import { PRIORITIES, ROLE_LABEL, ROLES, SLOT_LABEL, SLOTS } from '@diet/shared';
import { Plus, Search, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Input } from '@/ui/input';
import { api, ApiError } from '../api';
import { Switch } from '@/ui/switch';
import { ScreenHeader } from '../components/ScreenHeader';
import { Badge } from '@/ui/badge';
import { BottomSheet } from '../components/BottomSheet';
import {
  Button,
  Card,
  ErrorNote,
  NumberField,
  parseDecimal,
  Segmented,
  OptionSelect,
  Disclosure,
  MultiToggle,
} from '../components/ui';
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

      <div className="relative mb-4">
        <Search
          size={16}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          aria-label="Search foods"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          className="h-11 pl-9"
        />
      </div>

      {foods.status === 'error' && <ErrorNote>{foods.error.message}</ErrorNote>}
      {foods.data && foods.data.length === 0 && (
        <p className="text-sm text-muted-foreground">No foods yet. Add the ones your plan uses.</p>
      )}
      <FoodList foods={active} onPick={setEditing} />
      {archived.length > 0 && (
        <Disclosure
          className="mt-4"
          summaryClassName="text-sm text-muted-foreground"
          summary={<>Archived ({archived.length})</>}
        >
          <FoodList foods={archived} onPick={setEditing} />
        </Disclosure>
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
                {/* A long name truncates; the badge always stays visible. */}
                <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                  <span className="truncate">{f.name}</span>
                  {f.pool.inPool && <Badge variant="outline">pool</Badge>}
                </span>
                {f.brand && (
                  <span className="block truncate text-xs text-muted-foreground">{f.brand}</span>
                )}
              </span>
              <span className="shrink-0 text-right text-xs text-muted-foreground">
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
  const [pool, setPool] = useState<PoolInfo>(
    food?.pool ?? {
      inPool: true,
      role: 'other',
      preferredSlots: [],
      priority: 'medium',
      portion: { kind: 'flexible', stepG: 5 },
    },
  );
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
      pool,
      ...(archived !== undefined && { archived }),
    };
    if (!body.name) return setError('Give the food a name.');
    if (pool.portion.kind === 'fixed_unit' && !(pool.portion.unit in unitMap)) {
      return setError(`Whole-unit portions need the "${pool.portion.unit}" portion defined above.`);
    }
    setSaving(true);
    try {
      if (food) await api.patch(`/foods/${food.id}`, body);
      else await api.post('/foods', body);
      toast.success(food ? 'Food saved' : 'Food added');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <BottomSheet title={food ? 'Edit food' : 'New food'} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextRow label="Name" value={name} onChange={setName} />
        <TextRow label="Brand" value={brand} onChange={setBrand} />
        <p className="pt-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Per 100 g
        </p>
        <NumberField label="Energy" unit="kcal" value={kcal} onChange={setKcal} />
        <NumberField label="Protein" unit="g" value={protein} onChange={setProtein} />
        <NumberField label="Carbs" unit="g" value={carbs} onChange={setCarbs} />
        <NumberField label="Fat" unit="g" value={fat} onChange={setFat} />
        <NumberField label="Fibre" unit="g" value={fibre} onChange={setFibre} />
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">Values refer to</span>
          <OptionSelect label="Values refer to" value={basis} options={BASES} onChange={setBasis} />
        </div>

        <p className="pt-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Portions
        </p>
        {units.map((u, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              aria-label="Portion name"
              placeholder="cup, slice, pcs…"
              value={u.unit}
              onChange={(e) =>
                setUnits(units.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))
              }
              className="flex-1 h-11"
            />
            <Input
              aria-label="Grams per portion"
              inputMode="decimal"
              placeholder="g"
              value={u.grams}
              onChange={(e) =>
                setUnits(units.map((x, j) => (j === i ? { ...x, grams: e.target.value } : x)))
              }
              className="w-20 text-right h-11"
            />
            <span className="text-sm text-muted-foreground">g</span>
            <button
              type="button"
              aria-label="Remove portion"
              onClick={() => setUnits(units.filter((_, j) => j !== i))}
              className="rounded-full p-2 text-muted-foreground hover:bg-surface-2"
            >
              <X size={16} aria-hidden />
            </button>
          </div>
        ))}
        <Button variant="ghost" onClick={() => setUnits([...units, { unit: '', grams: '' }])}>
          <Plus size={16} aria-hidden /> Add a portion
        </Button>

        <PoolFields
          pool={pool}
          onChange={setPool}
          units={units.map((u) => u.unit.trim()).filter(Boolean)}
        />

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
    </BottomSheet>
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
      <Input value={value} onChange={(e) => onChange(e.target.value)} className="w-56 h-11" />
    </label>
  );
}

function PoolFields({
  pool,
  onChange,
  units,
}: {
  pool: PoolInfo;
  onChange: (p: PoolInfo) => void;
  units: string[];
}) {
  const set = (patch: Partial<PoolInfo>) => onChange({ ...pool, ...patch });
  return (
    <div className="space-y-3 pt-2">
      <label className="flex items-center justify-between">
        <span>
          <span className="block text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Planning pool
          </span>
          <span className="block text-xs text-muted-foreground">
            Foods the plan generator may use.
          </span>
        </span>
        <Switch
          checked={pool.inPool}
          onCheckedChange={(inPool) => set({ inPool })}
          aria-label="In the planning pool"
        />
      </label>
      {pool.inPool && (
        <>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">Role</span>
            <OptionSelect
              label="Role"
              value={pool.role}
              options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
              onChange={(role) => set({ role })}
            />
          </div>
          <div>
            <p className="mb-1 text-sm">Priority</p>
            <Segmented
              label="Priority"
              options={PRIORITIES.map((p) => ({
                value: p,
                label: p[0]!.toUpperCase() + p.slice(1),
              }))}
              value={pool.priority}
              onChange={(v) => v && set({ priority: v })}
            />
          </div>
          <div>
            <p className="mb-1 text-sm">Preferred meals</p>
            <MultiToggle
              label="Preferred meals"
              options={SLOTS.map((slot) => ({ value: slot, label: SLOT_LABEL[slot] }))}
              value={pool.preferredSlots}
              onToggle={(slot: Slot) =>
                set({
                  preferredSlots: pool.preferredSlots.includes(slot)
                    ? pool.preferredSlots.filter((x) => x !== slot)
                    : [...pool.preferredSlots, slot],
                })
              }
            />
          </div>
          <div className="space-y-2">
            <p className="text-sm">Portions in a plan</p>
            <Segmented
              label="Portioning"
              options={[
                { value: 'flexible', label: 'Any amount' },
                { value: 'fixed_unit', label: 'Whole units' },
              ]}
              value={pool.portion.kind}
              onChange={(v) =>
                v &&
                set({
                  portion:
                    v === 'flexible'
                      ? { kind: 'flexible', stepG: 5 }
                      : { kind: 'fixed_unit', unit: units[0] ?? '' },
                })
              }
            />
            {pool.portion.kind === 'flexible' ? (
              <NumberField
                label="In steps of"
                unit="g"
                value={String(pool.portion.stepG)}
                onChange={(v) => {
                  const step = parseDecimal(v);
                  if (step && step > 0) set({ portion: { kind: 'flexible', stepG: step } });
                }}
              />
            ) : units.length === 0 ? (
              <p className="text-xs text-warn">
                Add a portion above (e.g. cup = 150 g) to plan in whole units.
              </p>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm">Unit</span>
                <OptionSelect
                  label="Unit"
                  value={pool.portion.unit}
                  options={units.map((u) => ({ value: u, label: u }))}
                  onChange={(unit) => set({ portion: { kind: 'fixed_unit', unit } })}
                />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
