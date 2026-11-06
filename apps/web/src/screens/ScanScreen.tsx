import type {
  BarcodeLookupDto,
  FoodDto,
  FoodInput,
  LabelReadingDto,
  ScanContextDto,
  ScorePart,
} from '@diet/shared';
import { fitScore, nutriScore, qualityScore, SLOT_LABEL } from '@diet/shared';
import { Camera, Check, Plus, ScanBarcode, Search, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Input } from '@/ui/input';
import { api, ApiError } from '../api';
import { Badge } from '@/ui/badge';
import { ScreenHeader } from '../components/ScreenHeader';
import {
  Button,
  Card,
  ErrorNote,
  NumberField,
  parseDecimal,
  SectionTitle,
  OptionSelect,
  Disclosure,
} from '../components/ui';
import { shrinkPhoto } from '../image';

type Stage =
  | { kind: 'start' }
  | { kind: 'camera' }
  | { kind: 'looking'; code: string }
  | { kind: 'product'; food: FoodDto; context: ScanContextDto; via: 'scan' | 'search' }
  | { kind: 'missing'; code: string; reason: string | null };

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : String(err));

export function ScanScreen() {
  const [stage, setStage] = useState<Stage>({ kind: 'start' });
  const [error, setError] = useState<string | null>(null);

  // Stable callbacks: the camera effect depends on them and must not restart on re-renders.
  const lookup = useCallback(async (code: string) => {
    setError(null);
    setStage({ kind: 'looking', code });
    try {
      const result = await api.get<BarcodeLookupDto>(`/barcodes/${encodeURIComponent(code)}`);
      setStage(
        result.status === 'found'
          ? { kind: 'product', food: result.food, context: result.context, via: 'scan' }
          : { kind: 'missing', code, reason: result.reason },
      );
    } catch (err) {
      setError(errorText(err));
      setStage({ kind: 'start' });
    }
  }, []);
  const cameraFailed = useCallback((message: string) => {
    setError(message);
    setStage({ kind: 'start' });
  }, []);
  const onCode = useCallback((code: string) => void lookup(code), [lookup]);

  async function pickFood(food: FoodDto) {
    setError(null);
    try {
      const context = await api.get<ScanContextDto>(`/scan/context?foodId=${food.id}`);
      setStage({ kind: 'product', food, context, via: 'search' });
    } catch (err) {
      setError(errorText(err));
    }
  }

  const restart = () => setStage({ kind: 'start' });

  return (
    <>
      <ScreenHeader title="Scan">Rate a product and log it in one go.</ScreenHeader>
      <div className="space-y-4">
        {error && <ErrorNote>{error}</ErrorNote>}
        {stage.kind === 'start' && (
          <Start onCamera={() => setStage({ kind: 'camera' })} onCode={onCode} onPick={pickFood} />
        )}
        {stage.kind === 'camera' && (
          <CameraScanner onCode={onCode} onCancel={restart} onError={cameraFailed} />
        )}
        {stage.kind === 'looking' && (
          <p className="text-sm text-muted-foreground" role="status">
            Looking up {stage.code}…
          </p>
        )}
        {stage.kind === 'product' && (
          <ProductResult
            food={stage.food}
            context={stage.context}
            via={stage.via}
            onDone={restart}
          />
        )}
        {stage.kind === 'missing' && (
          <LabelCapture
            code={stage.code}
            reason={stage.reason}
            onSaved={() => void lookup(stage.code)}
            onCancel={restart}
          />
        )}
      </div>
    </>
  );
}

function Start({
  onCamera,
  onCode,
  onPick,
}: {
  onCamera: () => void;
  onCode: (code: string) => void;
  onPick: (food: FoodDto) => void;
}) {
  const [code, setCode] = useState('');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<FoodDto[]>([]);

  useEffect(() => {
    const needle = q.trim();
    if (needle.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void api
        .get<FoodDto[]>(`/foods?q=${encodeURIComponent(needle)}`)
        .then((foods) => !cancelled && setResults(foods.slice(0, 8)))
        .catch(() => {});
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  return (
    <>
      <button
        type="button"
        onClick={onCamera}
        className="flex w-full flex-col items-center gap-3 rounded-3xl bg-primary px-6 py-10 text-bg transition hover:opacity-90"
      >
        <ScanBarcode size={48} aria-hidden />
        <span className="text-lg font-bold">Scan a barcode</span>
      </button>

      <Card className="space-y-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) onCode(code.trim());
          }}
        >
          <label className="sr-only" htmlFor="barcode-input">
            Barcode number
          </label>
          <Input
            id="barcode-input"
            inputMode="numeric"
            placeholder="Or type the barcode number"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            className="flex-1 h-11"
          />
          <Button type="submit" variant="secondary" disabled={code.length < 8}>
            Look up
          </Button>
        </form>
        <div>
          <div className="relative">
            <Search
              size={16}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              aria-label="Search your foods"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                if (e.target.value.trim().length < 2) setResults([]);
              }}
              placeholder="Or search your foods (fresh food, no barcode)"
              className="h-11 pl-9"
            />
          </div>
          {results.length > 0 && (
            <ul className="mt-1 divide-y divide-border">
              {results.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    onClick={() => onPick(f)}
                    className="flex w-full justify-between px-1 py-2.5 text-left text-sm hover:bg-surface-2"
                  >
                    <span className="truncate">{f.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {Math.round(f.kcal)} kcal/100 g
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </>
  );
}

const SCAN_EVERY_MS = 200;

function CameraScanner({
  onCode,
  onCancel,
  onError,
}: {
  onCode: (code: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    // Per-run state: Strict Mode (and a changed callback) tears the effect down and runs it
    // again, and each run must start fresh and clean up only its own camera.
    let done = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const tick = async () => {
      const v = video.current;
      if (done || !v || !ctx) return;
      if (v.readyState >= 2 && v.videoWidth > 0) {
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        ctx.drawImage(v, 0, 0);
        try {
          // Loaded on first use: the reader (and its WebAssembly) stays out of the main bundle.
          const { readRetailBarcode } = await import('../barcode');
          const code = await readRetailBarcode(ctx.getImageData(0, 0, canvas.width, canvas.height));
          if (code && !done) {
            done = true;
            navigator.vibrate?.(50);
            onCode(code);
            return;
          }
        } catch {
          done = true;
          onError("The barcode reader couldn't start. Type the number instead.");
          return;
        }
      }
      timer = setTimeout(() => void tick(), SCAN_EVERY_MS);
    };

    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false })
      .then((s) => {
        // Permission can arrive after the scanner was closed: release the camera at once.
        if (done) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
        }
        void tick();
      })
      .catch(() => {
        if (!done) onError('No camera access. Allow the camera for this app, or type the number.');
      });
    if (!navigator.mediaDevices)
      onError('This browser has no camera access here. Type the number instead.');

    return () => {
      done = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onCode, onError]);

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-3xl bg-black">
        <video
          ref={video}
          playsInline
          muted
          className="aspect-[3/4] w-full object-cover"
          aria-label="Camera"
        />
        <div
          className="pointer-events-none absolute inset-x-8 top-1/2 h-24 -translate-y-1/2 rounded-xl border-2 border-white/80"
          aria-hidden
        />
      </div>
      <p className="text-center text-sm text-muted-foreground">
        Hold the barcode inside the frame.
      </p>
      <Button variant="secondary" className="w-full" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

const BAND: Record<
  'good' | 'ok' | 'poor' | 'avoid',
  {
    label: string;
    variant: 'default' | 'secondary' | 'outline' | 'destructive';
    className?: string;
  }
> = {
  good: { label: 'Good', variant: 'default' },
  ok: { label: 'OK', variant: 'secondary' },
  poor: { label: 'Poor', variant: 'outline', className: 'text-warn' },
  avoid: { label: 'Avoid', variant: 'destructive' },
};

function ScoreCard({
  title,
  score,
  band,
  parts,
  reasons,
}: {
  title: string;
  score: number | null;
  band: keyof typeof BAND | null;
  parts: ScorePart[];
  reasons?: string[];
}) {
  return (
    <Card className="space-y-2">
      <div className="flex items-center justify-between">
        <SectionTitle>{title}</SectionTitle>
        <span className="flex items-center gap-2">
          <span className="text-2xl font-bold">{score ?? '–'}</span>
          {band && (
            <Badge variant={BAND[band].variant} className={BAND[band].className}>
              {BAND[band].label}
            </Badge>
          )}
        </span>
      </div>
      {reasons && reasons.length > 0 && (
        <ul className="space-y-0.5 text-sm">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <Disclosure className="text-xs text-muted-foreground" summary="How it's scored">
        <ul className="mt-1 space-y-1">
          {parts.map((p) => (
            <li key={p.key} className="flex justify-between gap-3">
              <span>
                {p.label} ({p.weight}%): {p.detail}
              </span>
              <span className="shrink-0 font-medium">
                {p.value === null ? 'n/a' : Math.round(p.value)}
              </span>
            </li>
          ))}
        </ul>
      </Disclosure>
    </Card>
  );
}

function ProductResult({
  food,
  context,
  via,
  onDone,
}: {
  food: FoodDto;
  context: ScanContextDto;
  via: 'scan' | 'search';
  onDone: () => void;
}) {
  const units = Object.entries(food.units);
  const [unit, setUnit] = useState<string>(units.find(([u]) => u === 'serving')?.[0] ?? 'g');
  const [amount, setAmount] = useState(unit === 'g' ? '100' : '1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logged, setLogged] = useState(false);
  const [pooled, setPooled] = useState(food.pool.inPool);

  const qty = parseDecimal(amount);
  const grams = qty ? (unit === 'g' ? qty : qty * (food.units[unit] ?? 0)) : null;
  const portionG = grams ?? 100;

  const quality = qualityScore({
    nutriscoreGrade: food.product?.nutriscoreGrade ?? null,
    computed: nutriScore({
      kcal: food.kcal,
      sugarsG: food.sugarG,
      satFatG: food.satFatG,
      saltG: food.saltG,
      fibreG: food.fibreG,
      proteinG: food.proteinG,
      category: food.product?.category ?? 'general',
    }),
    novaGroup: food.product?.novaGroup ?? null,
    additives: food.product ? food.product.additives : null,
  });
  const fit = fitScore({
    per100: food,
    portionG,
    role: food.pool.inPool ? food.pool.role : null,
    phase: context.phase,
    remaining: context.remaining,
    slot: context.slot,
    slotRoles: context.slotRoles,
    ruleConflicts: context.conflicts,
  });
  const portion = (v: number) => Math.round((v * portionG) / 100);

  async function ate() {
    if (!grams || grams <= 0) return setError('Enter how much you ate.');
    setBusy(true);
    setError(null);
    try {
      await api.post('/food-log', { foodId: food.id, grams, slot: context.slot, via });
      setLogged(true);
      toast.success(`Logged ${Math.round(grams)} g at ${SLOT_LABEL[context.slot].toLowerCase()}.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function addToPool() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/foods/${food.id}`, {
        pool: {
          inPool: true,
          role: food.pool.role,
          preferredSlots: food.pool.preferredSlots.length
            ? food.pool.preferredSlots
            : [context.slot],
          priority: 'medium',
          portion: food.units.serving
            ? { kind: 'fixed_unit', unit: 'serving' }
            : { kind: 'flexible', stepG: 5 },
        },
      });
      setPooled(true);
      toast.success('Added to your planning pool');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-xl font-bold tracking-tight">{food.name}</h2>
        {food.brand && <p className="text-sm text-muted-foreground">{food.brand}</p>}
      </div>

      <ScoreCard
        title="Fit for you now"
        score={fit.score}
        band={null}
        parts={fit.parts}
        reasons={fit.reasons}
      />
      <ScoreCard
        title={quality.partial ? 'Quality (partial data)' : 'Quality'}
        score={quality.score}
        band={quality.band}
        parts={quality.parts}
      />

      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th className="text-left font-medium" />
              <th className="text-right font-medium">100 g</th>
              <th className="text-right font-medium">{Math.round(portionG)} g</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ['Energy', food.kcal, 'kcal'],
                ['Protein', food.proteinG, 'g'],
                ['Carbs', food.carbsG, 'g'],
                ['Sugars', food.sugarG, 'g'],
                ['Fat', food.fatG, 'g'],
                ['Saturated fat', food.satFatG, 'g'],
                ['Fibre', food.fibreG, 'g'],
              ] as [string, number | null, string][]
            ).map(([label, v, u]) => (
              <tr key={label} className="border-t border-border">
                <td className="py-1.5">{label}</td>
                <td className="py-1.5 text-right">
                  {v === null ? '–' : `${Math.round(v * 10) / 10} ${u}`}
                </td>
                <td className="py-1.5 text-right font-medium">
                  {v === null ? '–' : `${portion(v)} ${u}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="space-y-3">
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="ate-amount">
            Amount
          </label>
          <Input
            id="ate-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-24 text-right h-11"
          />
          <OptionSelect
            label="Unit"
            value={unit}
            options={[
              { value: 'g', label: 'g' },
              ...units.map(([u, g]) => ({ value: u, label: `${u} (${g} g)` })),
            ]}
            onChange={(next) => {
              setUnit(next);
              setAmount(next === 'g' ? String(Math.round(portionG)) : '1');
            }}
            className="min-h-11"
          />
          <Button className="flex-1" disabled={busy || logged} onClick={() => void ate()}>
            <Check size={18} aria-hidden /> {logged ? 'Logged' : 'Ate it'}
          </Button>
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex gap-2">
          {!pooled && (
            <Button variant="secondary" disabled={busy} onClick={() => void addToPool()}>
              <Plus size={16} aria-hidden /> Add to pool
            </Button>
          )}
          <Button variant="ghost" className="ml-auto" onClick={onDone}>
            {logged ? 'Scan another' : 'Close'}
          </Button>
        </div>
      </Card>
    </div>
  );
}

const FIELDS: [keyof LabelReadingDto['per100'], string, string][] = [
  ['kcal', 'Energy', 'kcal'],
  ['proteinG', 'Protein', 'g'],
  ['carbsG', 'Carbs', 'g'],
  ['sugarG', 'of which sugars', 'g'],
  ['fatG', 'Fat', 'g'],
  ['satFatG', 'of which saturated', 'g'],
  ['fibreG', 'Fibre', 'g'],
  ['saltG', 'Salt', 'g'],
];

function LabelCapture({
  code,
  reason,
  onSaved,
  onCancel,
}: {
  code: string;
  reason: string | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [serving, setServing] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [filled, setFilled] = useState(false);

  async function read(file: File) {
    setReading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append(
        'photo',
        new File([await shrinkPhoto(file)], 'label.jpg', { type: 'image/jpeg' }),
      );
      const r = await api.post<LabelReadingDto>('/labels/read', form);
      setName(r.name ?? '');
      setBrand(r.brand ?? '');
      setServing(r.servingG ? String(r.servingG) : '');
      setValues(
        Object.fromEntries(
          FIELDS.map(([k]) => [k, r.per100[k] === null ? '' : String(r.per100[k])]),
        ),
      );
      setNotes(r.notes);
      setFilled(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setReading(false);
    }
  }

  async function save() {
    setError(null);
    const v = (k: string) => parseDecimal(values[k] ?? '');
    const required = ['kcal', 'proteinG', 'carbsG', 'fatG'].map(v);
    if (!name.trim()) return setError('Give the product a name.');
    if (required.some((x) => x == null))
      return setError('Energy, protein, carbs and fat are needed.');
    const servingG = parseDecimal(serving);
    const body: FoodInput = {
      name: name.trim(),
      brand: brand.trim() || null,
      kcal: required[0]!,
      proteinG: required[1]!,
      carbsG: required[2]!,
      fatG: required[3]!,
      fibreG: v('fibreG') ?? null,
      sugarG: v('sugarG') ?? null,
      satFatG: v('satFatG') ?? null,
      saltG: v('saltG') ?? null,
      units: servingG ? { serving: servingG } : {},
      barcode: code,
    };
    setSaving(true);
    try {
      await api.post('/foods', body);
      onSaved();
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between">
        <div>
          <SectionTitle>Not in Open Food Facts</SectionTitle>
          <p className="text-sm text-muted-foreground">
            {reason ?? `No product with barcode ${code}.`} Take a photo of the nutrition label and
            it gets read for you; check the numbers before saving.
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel"
          className="rounded-full p-2 text-muted-foreground hover:bg-surface-2"
        >
          <X size={18} aria-hidden />
        </button>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void read(file);
        }}
      />
      <Button
        variant={filled ? 'secondary' : 'primary'}
        disabled={reading}
        onClick={() => input.current?.click()}
      >
        <Camera size={18} aria-hidden />{' '}
        {reading ? 'Reading the label…' : filled ? 'Retake the photo' : 'Photograph the label'}
      </Button>

      {filled && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {notes.length > 0 && (
            <ul className="rounded-xl bg-surface-2 px-3 py-2 text-xs text-muted-foreground">
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <label className="flex items-center justify-between gap-3">
            <span className="text-sm">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="w-56 h-11" />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span className="text-sm">Brand</span>
            <Input value={brand} onChange={(e) => setBrand(e.target.value)} className="w-56 h-11" />
          </label>
          <p className="pt-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Per 100 g
          </p>
          {FIELDS.map(([key, label, unit]) => (
            <NumberField
              key={key}
              label={label}
              unit={unit}
              value={values[key] ?? ''}
              onChange={(v) => setValues({ ...values, [key]: v })}
            />
          ))}
          <NumberField label="Serving" unit="g" value={serving} onChange={setServing} />
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button type="submit" disabled={saving} className="w-full">
            {saving ? 'Saving…' : 'Save the product'}
          </Button>
        </form>
      )}
      {!filled && error && <ErrorNote>{error}</ErrorNote>}
    </Card>
  );
}
