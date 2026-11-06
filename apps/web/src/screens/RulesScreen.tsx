import type { FoodDto, Role, RuleDto, RuleKind, RuleSpec, Slot } from '@diet/shared';
import { ROLE_LABEL, ROLES, RULE_KIND_LABEL, SLOT_LABEL, SLOTS } from '@diet/shared';
import { Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Textarea } from '@/ui/textarea';
import { api, ApiError } from '../api';
import { Switch } from '@/ui/switch';
import { ScreenHeader } from '../components/ScreenHeader';
import { Badge } from '@/ui/badge';
import { Command, CommandInput, CommandItem, CommandList } from '@/ui/command';
import { BottomSheet } from '../components/BottomSheet';
import { ConfirmDialog } from '../components/ConfirmDialog';
import {
  Button,
  Card,
  ErrorNote,
  NumberField,
  parseDecimal,
  Segmented,
  OptionSelect,
  MultiToggle,
} from '../components/ui';
import { useQuery } from '../useQuery';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const KINDS = Object.keys(RULE_KIND_LABEL) as RuleKind[];

export function RulesScreen() {
  const rules = useQuery<RuleDto[]>('/rules');
  const foods = useQuery<FoodDto[]>('/foods');
  const [editing, setEditing] = useState<RuleDto | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(rule: RuleDto) {
    setError(null);
    try {
      await api.put(`/rules/${rule.id}`, {
        spec: rule.spec,
        text: rule.text,
        active: !rule.active,
      });
      await rules.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <>
      <div className="flex items-start justify-between">
        <ScreenHeader title="Rules">What every generated plan must respect.</ScreenHeader>
        <Button variant="ghost" className="-mr-2" onClick={() => setEditing('new')}>
          <Plus size={18} aria-hidden /> Add
        </Button>
      </div>
      {rules.status === 'error' && <ErrorNote>{rules.error.message}</ErrorNote>}
      {error && <ErrorNote>{error}</ErrorNote>}
      {rules.data && rules.data.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No rules yet. Add the ones from your Diet Planning Rules note: yogurt at most twice a day,
          no potatoes on training days, and so on.
        </p>
      )}
      {rules.data && rules.data.length > 0 && (
        <Card className="p-0">
          <ul className="divide-y divide-border">
            {rules.data.map((r) => (
              <li key={r.id} className="flex items-start gap-3 px-4 py-3">
                <Switch
                  checked={r.active}
                  onCheckedChange={() => void toggle(r)}
                  aria-label={`Rule active: ${r.text}`}
                  className="mt-0.5"
                />
                <button
                  type="button"
                  onClick={() => setEditing(r)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span
                    className={`block text-sm ${r.active ? '' : 'text-muted-foreground line-through'}`}
                  >
                    {r.text}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {RULE_KIND_LABEL[r.spec.kind]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {editing && foods.data && (
        <RuleSheet
          rule={editing === 'new' ? null : editing}
          foods={foods.data}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void rules.reload();
          }}
        />
      )}
    </>
  );
}

function blankSpec(kind: RuleKind): RuleSpec {
  switch (kind) {
    case 'exclude_food':
      return { kind, foodIds: [] };
    case 'max_items_per_day':
      return { kind, foodIds: [], max: 2 };
    case 'not_same_day':
      return { kind, foodIds: [] };
    case 'forbidden_on_day_type':
      return { kind, foodIds: [], dayType: 'training' };
    case 'allowed_weekdays':
      return { kind, foodIds: [], weekdays: [1, 2, 3, 4, 5] };
    case 'min_portion':
      return { kind, foodIds: [], minG: 50, fallbackFoodIds: [] };
    case 'no_repeat_role_lunch_dinner':
      return { kind, roles: ['main_protein', 'main_carb'] };
    case 'fixed_portion':
      return { kind, foodIds: [], slot: 'dinner', grams: 100 };
    case 'fixed_slots':
      return { kind, slots: ['breakfast', 'morning_snack'] };
    case 'guidance':
      return { kind };
  }
}

/** A sentence for the rule when none was typed. */
function describe(spec: RuleSpec, names: (ids: string[]) => string): string {
  switch (spec.kind) {
    case 'exclude_food':
      return `Never use ${names(spec.foodIds)}.`;
    case 'max_items_per_day':
      return `At most ${spec.max} of ${names(spec.foodIds)} per day.`;
    case 'not_same_day':
      return `${names(spec.foodIds)} never on the same day.`;
    case 'forbidden_on_day_type':
      return `No ${names(spec.foodIds)} on ${spec.dayType} days.`;
    case 'allowed_weekdays':
      return `${names(spec.foodIds)} only on ${spec.weekdays.map((d) => WEEKDAYS[d - 1]).join(', ')}.`;
    case 'min_portion':
      return `${names(spec.foodIds)} at least ${spec.minG} g, otherwise ${names(spec.fallbackFoodIds) || 'a swap'}.`;
    case 'no_repeat_role_lunch_dinner':
      return `Lunch and dinner don't share the ${spec.roles.map((r) => ROLE_LABEL[r].toLowerCase()).join(' or ')}.`;
    case 'fixed_portion':
      return `${names(spec.foodIds)} at ${SLOT_LABEL[spec.slot].toLowerCase()} is always ${spec.grams} g.`;
    case 'fixed_slots':
      return `Keep ${spec.slots.map((s) => SLOT_LABEL[s].toLowerCase()).join(' and ')} as they are.`;
    case 'guidance':
      return '';
  }
}

function RuleSheet({
  rule,
  foods,
  onClose,
  onSaved,
}: {
  rule: RuleDto | null;
  foods: FoodDto[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [spec, setSpec] = useState<RuleSpec>(rule?.spec ?? blankSpec('exclude_food'));
  const [text, setText] = useState(rule?.text ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nameOf = new Map(foods.map((f) => [f.id, f.name]));
  const names = (ids: string[]) => ids.map((id) => nameOf.get(id) ?? '?').join(', ');
  const set = (patch: Partial<RuleSpec>) => setSpec({ ...spec, ...patch } as RuleSpec);

  async function save() {
    setError(null);
    if ('foodIds' in spec && spec.foodIds.length === 0) return setError('Pick at least one food.');
    if (spec.kind === 'not_same_day' && spec.foodIds.length < 2)
      return setError('Pick at least two foods.');
    const finalText = text.trim() || describe(spec, names);
    if (!finalText) return setError('Write the guidance.');
    setBusy(true);
    try {
      const body = { spec, text: finalText, active: rule?.active ?? true };
      if (rule) await api.put(`/rules/${rule.id}`, body);
      else await api.post('/rules', body);
      toast.success(rule ? 'Rule saved' : 'Rule added');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (!rule) return;
    setConfirmDelete(false);
    setBusy(true);
    try {
      await api.delete(`/rules/${rule.id}`);
      toast.success('Rule deleted');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <BottomSheet title={rule ? 'Edit rule' : 'New rule'} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">Type</span>
          <OptionSelect
            label="Type"
            value={spec.kind}
            options={KINDS.map((k) => ({ value: k, label: RULE_KIND_LABEL[k] }))}
            onChange={(k) => setSpec(blankSpec(k))}
          />
        </div>

        {'foodIds' in spec && (
          <FoodPicker
            label={spec.kind === 'fixed_portion' ? 'Food' : 'Foods'}
            single={spec.kind === 'fixed_portion'}
            foods={foods}
            value={spec.foodIds}
            onChange={(foodIds) => set({ foodIds })}
          />
        )}
        {spec.kind === 'max_items_per_day' && (
          <NumberField
            label="At most, per day"
            unit=""
            value={String(spec.max)}
            onChange={(v) => {
              const n = parseDecimal(v);
              if (n != null) set({ max: Math.round(n) });
            }}
          />
        )}
        {spec.kind === 'forbidden_on_day_type' && (
          <Segmented
            label="Day type"
            options={[
              { value: 'training', label: 'Training days' },
              { value: 'rest', label: 'Rest days' },
            ]}
            value={spec.dayType}
            onChange={(v) => v && set({ dayType: v })}
          />
        )}
        {spec.kind === 'allowed_weekdays' && (
          <Toggles
            label="Allowed on"
            options={WEEKDAYS.map((w, i) => ({ value: i + 1, label: w }))}
            value={spec.weekdays}
            onChange={(weekdays) => set({ weekdays })}
          />
        )}
        {spec.kind === 'min_portion' && (
          <>
            <NumberField
              label="Minimum"
              unit="g"
              value={String(spec.minG)}
              onChange={(v) => {
                const n = parseDecimal(v);
                if (n) set({ minG: n });
              }}
            />
            <FoodPicker
              label="Otherwise use"
              foods={foods}
              value={spec.fallbackFoodIds}
              onChange={(fallbackFoodIds) => set({ fallbackFoodIds })}
            />
          </>
        )}
        {spec.kind === 'no_repeat_role_lunch_dinner' && (
          <Toggles
            label="Don't repeat"
            options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
            value={spec.roles}
            onChange={(roles) => set({ roles: roles as Role[] })}
          />
        )}
        {spec.kind === 'fixed_portion' && (
          <>
            <SlotSelect value={spec.slot} onChange={(slot) => set({ slot })} />
            <NumberField
              label="Always"
              unit="g"
              value={String(spec.grams)}
              onChange={(v) => {
                const n = parseDecimal(v);
                if (n) set({ grams: n });
              }}
            />
          </>
        )}
        {spec.kind === 'fixed_slots' && (
          <Toggles
            label="Keep as in the current plan"
            options={SLOTS.map((s) => ({ value: s, label: SLOT_LABEL[s] }))}
            value={spec.slots}
            onChange={(slots) => set({ slots: slots as Slot[] })}
          />
        )}

        <label className="block">
          <span className="text-sm">
            {spec.kind === 'guidance' ? 'Guidance' : 'In words (optional)'}
          </span>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder={describe(spec, names)}
            className="mt-1 w-full"
          />
        </label>

        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy} className="flex-1">
            {busy ? 'Saving…' : 'Save'}
          </Button>
          {rule && (
            <Button variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
              <Trash2 size={16} aria-hidden /> Delete
            </Button>
          )}
        </div>
      </form>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this rule?"
        description="The planner stops following it. This can't be undone."
        confirmLabel="Delete rule"
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(false)}
      />
    </BottomSheet>
  );
}

function FoodPicker({
  label,
  foods,
  value,
  onChange,
  single = false,
}: {
  label: string;
  foods: FoodDto[];
  value: string[];
  onChange: (ids: string[]) => void;
  single?: boolean;
}) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const chosen = foods.filter((f) => value.includes(f.id));
  const matches = needle
    ? foods
        .filter((f) => !value.includes(f.id) && f.name.toLowerCase().includes(needle))
        .slice(0, 8)
    : [];
  return (
    <div>
      <p className="mb-1 text-sm">{label}</p>
      <div className="mb-2 flex flex-wrap gap-1">
        {chosen.map((f) => (
          <Badge key={f.id} variant="secondary" asChild>
            <button
              type="button"
              onClick={() => onChange(value.filter((id) => id !== f.id))}
              aria-label={`Remove ${f.name}`}
            >
              {f.name} <X aria-hidden />
            </button>
          </Badge>
        ))}
      </div>
      {(!single || chosen.length === 0) && (
        <>
          {/* Our own matching (name contains the text, chosen foods left out), so no cmdk filter. */}
          <Command shouldFilter={false} className="rounded-lg border">
            <CommandInput
              // 16 px: iOS Safari zooms into inputs with smaller text.
              className="text-base"
              value={q}
              onValueChange={setQ}
              placeholder="Search foods"
              aria-label={`Search ${label.toLowerCase()}`}
            />
            {matches.length > 0 && (
              <CommandList>
                {matches.map((f) => (
                  <CommandItem
                    key={f.id}
                    value={f.id}
                    onSelect={() => {
                      onChange(single ? [f.id] : [...value, f.id]);
                      setQ('');
                    }}
                  >
                    {f.name}
                  </CommandItem>
                ))}
              </CommandList>
            )}
          </Command>
        </>
      )}
    </div>
  );
}

function Toggles<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T[];
  onChange: (v: T[]) => void;
}) {
  return (
    <div>
      <p className="mb-1 text-sm">{label}</p>
      <MultiToggle
        label={label}
        options={options}
        value={value}
        onToggle={(v) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])}
      />
    </div>
  );
}

function SlotSelect({ value, onChange }: { value: Slot; onChange: (s: Slot) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm">Meal</span>
      <OptionSelect
        label="Meal"
        value={value}
        options={SLOTS.map((s) => ({ value: s, label: SLOT_LABEL[s] }))}
        onChange={onChange}
      />
    </div>
  );
}
