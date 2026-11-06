import type {
  DayTargetsDto,
  FoodDto,
  MealPlanDto,
  Per100,
  PlanDay,
  PlanDocument,
  PlanItem,
  PlanMeal,
  PlanOverviewDto,
  Slot,
} from '@diet/shared';
import { dayMacros, itemMacros, SLOT_LABEL, SLOTS } from '@diet/shared';
import { Copy, Plus, Trash2, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Input } from '@/ui/input';
import { api, ApiError } from '../api';
import { ScreenHeader } from '../components/ScreenHeader';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/ui/command';
import { BottomSheet } from '../components/BottomSheet';
import {
  Button,
  Card,
  ErrorNote,
  parseDecimal,
  OptionSelect,
  Loading,
  MultiToggle,
} from '../components/ui';
import { useQuery } from '../useQuery';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function PlanEditorScreen() {
  const { id } = useParams();
  const plan = useQuery<MealPlanDto>(`/plans/${id}`);
  const foods = useQuery<FoodDto[]>('/foods');
  const overview = useQuery<PlanOverviewDto>('/plan');

  if (plan.status === 'error') return <ErrorNote>{plan.error.message}</ErrorNote>;
  if (!plan.data || !foods.data || !overview.data) return <Loading />;
  return <Editor plan={plan.data} foods={foods.data} overview={overview.data} />;
}

type Lookup = (foodId: string) => Per100 | undefined;

function Editor({
  plan,
  foods,
  overview,
}: {
  plan: MealPlanDto;
  foods: FoodDto[];
  overview: PlanOverviewDto;
}) {
  const navigate = useNavigate();
  const [doc, setDoc] = useState<PlanDocument>(plan.document);
  const [name, setName] = useState(plan.name);
  const [weekday, setWeekday] = useState(() => ((new Date().getDay() + 6) % 7) + 1);
  const [dirty, setDirty] = useState(false);
  // Bumped on every edit, so a save that returns after further edits doesn't overwrite them.
  const revision = useRef(0);
  function touch() {
    revision.current++;
    setDirty(true);
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<{ slot: Slot; option: number } | null>(null);
  const [copying, setCopying] = useState(false);

  const foodById = useMemo(() => new Map(foods.map((f) => [f.id, f])), [foods]);
  const lookup: Lookup = (foodId) => foodById.get(foodId);
  const day = doc.days.find((d) => d.weekday === weekday)!;
  const training = overview.trainingWeekdays.includes(weekday);
  const target = overview.targets
    ? training
      ? overview.targets.training
      : overview.targets.rest
    : null;

  function updateDay(fn: (d: PlanDay) => PlanDay) {
    setDoc({ days: doc.days.map((d) => (d.weekday === weekday ? fn(structuredClone(d)) : d)) });
    touch();
  }

  function updateMeal(slot: Slot, fn: (m: PlanMeal) => PlanMeal | null) {
    updateDay((d) => ({
      ...d,
      meals: d.meals.flatMap((m) =>
        m.slot === slot ? [fn(m)].filter((x): x is PlanMeal => x !== null) : [m],
      ),
    }));
  }

  function addMeal(slot: Slot) {
    updateDay((d) => ({
      ...d,
      meals: [...d.meals, { slot, options: [{ label: 'A', items: [] }] }].sort(
        (a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot),
      ),
    }));
    setPicking({ slot, option: 0 });
  }

  function addFood(food: FoodDto) {
    if (!picking) return;
    const unit = Object.keys(food.units)[0];
    const item: PlanItem = unit
      ? { foodId: food.id, grams: food.units[unit]!, display: { unit, qty: 1 } }
      : { foodId: food.id, grams: 100 };
    updateMeal(picking.slot, (m) => {
      m.options[picking.option]!.items.push(item);
      return m;
    });
    setPicking(null);
  }

  function copyTo(weekdays: number[]) {
    setDoc({
      days: doc.days.map((d) =>
        weekdays.includes(d.weekday) ? { ...structuredClone(day), weekday: d.weekday } : d,
      ),
    });
    touch();
    setCopying(false);
  }

  /** Options with no items can't be saved; drop them (and meals left without options). */
  function cleaned(): PlanDocument {
    return {
      days: doc.days.map((d) => ({
        ...d,
        meals: d.meals
          .map((m) => ({ ...m, options: m.options.filter((o) => o.items.length > 0) }))
          .filter((m) => m.options.length > 0),
      })),
    };
  }

  async function save(): Promise<boolean> {
    setBusy(true);
    setError(null);
    const sentRevision = revision.current;
    try {
      const saved = await api.put<MealPlanDto>(`/plans/${plan.id}`, {
        name: name.trim() || plan.name,
        document: cleaned(),
      });
      // Edits made while saving stay on screen and keep the plan marked unsaved.
      if (revision.current === sentRevision) {
        setDoc(saved.document);
        setDirty(false);
      }
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    if (dirty && !(await save())) return;
    setBusy(true);
    try {
      await api.post(`/plans/${plan.id}/activate`);
      navigate('/plan');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  const missingSlots = SLOTS.filter((s) => !day.meals.some((m) => m.slot === s));

  return (
    <>
      <ScreenHeader title="Edit plan">
        {plan.status === 'active'
          ? 'Active plan: changes apply as soon as you save.'
          : 'Draft: activate it to use it on Today.'}
      </ScreenHeader>

      <div className="space-y-4">
        <Input
          aria-label="Plan name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            touch();
          }}
          className="w-full font-semibold h-11"
        />

        <Tabs value={String(weekday)} onValueChange={(v) => setWeekday(Number(v))}>
          <TabsList aria-label="Day" className="w-full">
            {WEEKDAYS.map((label, i) => (
              <TabsTrigger
                key={label}
                value={String(i + 1)}
                // Training days are underlined.
                className={
                  overview.trainingWeekdays.includes(i + 1)
                    ? 'underline decoration-primary decoration-2 underline-offset-4'
                    : ''
                }
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={String(weekday)} className="space-y-4">
            <DayTotals day={day} lookup={lookup} target={target} training={training} />

            {day.meals.map((meal) => (
              <MealCard
                key={`${weekday}-${meal.slot}`}
                meal={meal}
                lookup={lookup}
                foodById={foodById}
                onChange={(fn) => updateMeal(meal.slot, fn)}
                onAddFood={(option) => setPicking({ slot: meal.slot, option })}
              />
            ))}

            {missingSlots.length > 0 && (
              <OptionSelect
                label="Add a meal"
                value=""
                placeholder="+ Add a meal…"
                options={missingSlots.map((s) => ({ value: s, label: SLOT_LABEL[s] }))}
                onChange={addMeal}
                className="min-h-11 w-full border-dashed"
              />
            )}

            {day.meals.length > 0 && (
              <Button variant="ghost" onClick={() => setCopying(true)}>
                <Copy size={16} aria-hidden /> Copy {WEEKDAYS[weekday - 1]} to other days
              </Button>
            )}
          </TabsContent>
        </Tabs>

        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="sticky bottom-24 flex gap-2 rounded-2xl bg-bg/90 py-2 backdrop-blur">
          <Button disabled={busy || !dirty} onClick={() => void save()} className="flex-1">
            {busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </Button>
          {plan.status === 'draft' && (
            <Button variant="secondary" disabled={busy} onClick={() => void activate()}>
              Activate
            </Button>
          )}
        </div>
      </div>

      {picking && <FoodPicker foods={foods} onPick={addFood} onClose={() => setPicking(null)} />}
      {copying && <CopySheet from={weekday} onCopy={copyTo} onClose={() => setCopying(false)} />}
    </>
  );
}

function DayTotals({
  day,
  lookup,
  target,
  training,
}: {
  day: PlanDay;
  lookup: Lookup;
  target: DayTargetsDto | null;
  training: boolean;
}) {
  const t = dayMacros(day, lookup);
  const cells: [string, number, number | undefined, string][] = [
    ['kcal', t.kcal, target?.kcal, ''],
    ['Protein', t.proteinG, target?.proteinG, 'g'],
    ['Carbs', t.carbsG, target?.carbsG, 'g'],
    ['Fat', t.fatG, target?.fatG, 'g'],
  ];
  return (
    <Card className="py-3">
      <p className="mb-2 text-xs text-muted-foreground">
        {training ? 'Training day' : 'Rest day'} · default options
      </p>
      <dl className="grid grid-cols-4 gap-2 text-center">
        {cells.map(([label, value, goal, unit]) => {
          const off = goal ? (value - goal) / goal : 0;
          // Protein is a floor: only "under" is a problem.
          const bad = label === 'Protein' ? off < -0.03 : Math.abs(off) > 0.05;
          return (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className={`text-base font-bold ${goal && bad ? 'text-warn' : ''}`}>
                {Math.round(value)}
                {unit}
              </dd>
              {goal !== undefined && <dd className="text-xs text-muted-foreground">/ {goal}</dd>}
            </div>
          );
        })}
      </dl>
    </Card>
  );
}

function MealCard({
  meal,
  lookup,
  foodById,
  onChange,
  onAddFood,
}: {
  meal: PlanMeal;
  lookup: Lookup;
  foodById: Map<string, FoodDto>;
  onChange: (fn: (m: PlanMeal) => PlanMeal | null) => void;
  onAddFood: (option: number) => void;
}) {
  const [active, setActive] = useState(0);
  const index = Math.min(active, meal.options.length - 1);
  const option = meal.options[index]!;
  const kcal = option.items.reduce((sum, item) => {
    const per100 = item.snapshot ?? lookup(item.foodId);
    return per100 ? sum + itemMacros(per100, item.grams).kcal : sum;
  }, 0);

  function setItem(i: number, item: PlanItem | null) {
    onChange((m) => {
      const items = m.options[index]!.items;
      if (item) items[i] = item;
      else items.splice(i, 1);
      return m;
    });
  }

  return (
    <Card className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{SLOT_LABEL[meal.slot]}</h3>
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          {Math.round(kcal)} kcal
          <button
            type="button"
            aria-label={`Remove ${SLOT_LABEL[meal.slot]}`}
            onClick={() => onChange(() => null)}
            className="rounded-full p-1.5 hover:bg-surface-2"
          >
            <Trash2 size={16} aria-hidden />
          </button>
        </span>
      </div>

      <Tabs value={String(index)} onValueChange={(v) => setActive(Number(v))}>
        <div className="flex flex-wrap items-center gap-1">
          <TabsList aria-label="Options">
            {meal.options.map((o, i) => (
              <TabsTrigger key={i} value={String(i)}>
                {o.label}
                {i === 0 && <span className="font-normal"> · default</span>}
              </TabsTrigger>
            ))}
          </TabsList>
          {meal.options.length < 6 && (
            <button
              type="button"
              onClick={() => {
                onChange((m) => {
                  m.options.push({ label: String.fromCharCode(65 + m.options.length), items: [] });
                  return m;
                });
                setActive(meal.options.length);
              }}
              className="rounded-lg px-2 py-1 text-xs font-medium text-primary"
            >
              + Option
            </button>
          )}
          {meal.options.length > 1 && (
            <button
              type="button"
              onClick={() => {
                onChange((m) => {
                  m.options.splice(index, 1);
                  return m;
                });
                setActive(0);
              }}
              className="ml-auto text-xs text-muted-foreground"
            >
              Remove option {option.label}
            </button>
          )}
        </div>

        <TabsContent value={String(index)}>
          <ul className="divide-y divide-border">
            {option.items.map((item, i) => (
              <ItemRow
                key={`${item.foodId}-${i}`}
                item={item}
                food={foodById.get(item.foodId)}
                per100={item.snapshot ?? lookup(item.foodId)}
                onChange={(next) => setItem(i, next)}
              />
            ))}
          </ul>
          <Button variant="ghost" onClick={() => onAddFood(index)}>
            <Plus size={16} aria-hidden /> Add food
          </Button>
        </TabsContent>
      </Tabs>
    </Card>
  );
}

function ItemRow({
  item,
  food,
  per100,
  onChange,
}: {
  item: PlanItem;
  food: FoodDto | undefined;
  per100: Per100 | undefined;
  onChange: (item: PlanItem | null) => void;
}) {
  const units = food?.units ?? {};
  const unit = item.display?.unit ?? 'g';
  // While typing, show exactly what was typed; otherwise always show the item's value, so a
  // reused row (another day, option or a removed neighbour) never shows a stale amount.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(item.display?.qty ?? Math.round(item.grams * 10) / 10);
  const m = per100 ? itemMacros(per100, item.grams) : null;
  const name = item.snapshot?.name ?? food?.name ?? 'Unknown food';

  function commit(value: string, nextUnit = unit) {
    const qty = parseDecimal(value);
    if (qty == null || qty <= 0) return;
    if (nextUnit === 'g') onChange({ foodId: item.foodId, grams: qty, display: null });
    else
      onChange({
        foodId: item.foodId,
        grams: qty * (units[nextUnit] ?? 1),
        display: { unit: nextUnit, qty },
      });
  }

  return (
    <li className="flex items-center gap-2 py-2">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{name}</span>
        {m && (
          <span className="block text-xs text-muted-foreground">
            {Math.round(m.kcal)} kcal · P {m.proteinG.toFixed(0)} · C {m.carbsG.toFixed(0)} · F{' '}
            {m.fatG.toFixed(0)}
            {unit !== 'g' && ` · ${Math.round(item.grams)} g`}
          </span>
        )}
      </span>
      <Input
        aria-label={`Amount of ${name}`}
        inputMode="decimal"
        value={shown}
        onFocus={() => setDraft(shown)}
        onBlur={() => setDraft(null)}
        onChange={(e) => {
          setDraft(e.target.value);
          commit(e.target.value);
        }}
        className="w-16 text-right"
      />
      <OptionSelect
        label={`Unit for ${name}`}
        value={unit}
        size="sm"
        options={['g', ...Object.keys(units)].map((u) => ({ value: u, label: u }))}
        onChange={(next) => commit(next === 'g' ? String(Math.round(item.grams)) : '1', next)}
      />
      <button
        type="button"
        aria-label={`Remove ${name}`}
        onClick={() => onChange(null)}
        className="rounded-full p-1.5 text-muted-foreground hover:bg-surface-2"
      >
        <X size={16} aria-hidden />
      </button>
    </li>
  );
}

function FoodPicker({
  foods,
  onPick,
  onClose,
}: {
  foods: FoodDto[];
  onPick: (f: FoodDto) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const shown = foods.filter(
    (f) => !needle || `${f.name} ${f.brand ?? ''}`.toLowerCase().includes(needle),
  );
  return (
    <BottomSheet title="Pick a food" onClose={onClose} focusFirstField>
      {/* Our own matching (name or brand contains the text), so no cmdk filter. */}
      <Command shouldFilter={false} className="overflow-visible">
        {/* Stays in view while the list scrolls under it. */}
        <div className="sticky top-0 z-10 mb-1 bg-popover">
          <CommandInput
            // 16 px: iOS Safari zooms into inputs with smaller text.
            className="text-base"
            autoFocus
            value={q}
            onValueChange={setQ}
            placeholder="Search foods"
            aria-label="Search foods"
          />
        </div>
        {foods.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No foods yet.{' '}
            <Link to="/foods" className="font-semibold text-primary">
              Add your foods
            </Link>{' '}
            first (save this plan before leaving).
          </p>
        )}
        {/* The sheet scrolls, not the list. */}
        <CommandList className="max-h-none overflow-visible">
          {foods.length > 0 && <CommandEmpty>No food matches.</CommandEmpty>}
          {shown.map((f) => (
            <CommandItem key={f.id} value={f.id} onSelect={() => onPick(f)} className="py-2.5">
              <span className="truncate">{f.name}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {Math.round(f.kcal)} kcal · P {f.proteinG}
              </span>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </BottomSheet>
  );
}

function CopySheet({
  from,
  onCopy,
  onClose,
}: {
  from: number;
  onCopy: (days: number[]) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  return (
    <BottomSheet
      title={`Copy ${WEEKDAYS[from - 1]} to…`}
      description="The chosen days' meals are replaced."
      onClose={onClose}
    >
      <div className="space-y-3">
        <MultiToggle
          label="Days"
          fill
          options={WEEKDAYS.flatMap((label, i) =>
            i + 1 === from ? [] : [{ value: i + 1, label }],
          )}
          value={selected}
          onToggle={(day) =>
            setSelected(
              selected.includes(day) ? selected.filter((d) => d !== day) : [...selected, day],
            )
          }
        />
        <div className="flex gap-2">
          <Button
            className="flex-1"
            disabled={selected.length === 0}
            onClick={() => onCopy(selected)}
          >
            Copy
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}
