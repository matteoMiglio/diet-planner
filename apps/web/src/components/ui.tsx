import { ChevronRight, CircleAlert } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription } from '@/ui/alert';
import { Input } from '@/ui/input';
import { Button as ShadcnButton } from '@/ui/button';
import { Card as ShadcnCard } from '@/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { Skeleton } from '@/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';

/**
 * shadcn's Card (border, radius, shadow), laid out as a plain block with 16 px padding: the
 * cards hold free-form content, and shadcn's 24 px padding is a lot on a phone.
 */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <ShadcnCard className={cn('block p-4', className)}>{children}</ShadcnCard>;
}

export function SectionTitle({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2
      id={id}
      className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
    >
      {children}
    </h2>
  );
}

type ButtonProps = Omit<ComponentProps<typeof ShadcnButton>, 'variant' | 'size'> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'destructive';
};

/**
 * shadcn's Button with the app's names and a 44 px tap target. `ghost` is a green text button,
 * `danger` a red one; `destructive` is shadcn's solid red. Never submits a form unless asked to.
 */
export function Button({ variant = 'primary', className, ...props }: ButtonProps) {
  const [shadcnVariant, extra] = (
    {
      primary: ['default', ''],
      secondary: ['secondary', ''],
      ghost: ['ghost', 'text-primary hover:text-primary'],
      danger: ['ghost', 'text-destructive hover:text-destructive'],
      destructive: ['destructive', ''],
    } as const
  )[variant];
  return (
    <ShadcnButton
      type="button"
      {...props}
      variant={shadcnVariant}
      size="lg"
      className={cn('h-auto min-h-11 px-4', extra, className)}
    />
  );
}

export interface Option<T extends string | number> {
  value: T;
  label: string;
}

/**
 * A row of mutually exclusive choices, on shadcn's ToggleGroup (arrow keys move between them).
 * Tapping the selected one again clears it.
 */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Option<T>[];
  value: T | null;
  onChange: (value: T | null) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      aria-label={label}
      variant="outline"
      size="lg"
      className="w-full"
      value={value === null ? '' : String(value)}
      onValueChange={(next) =>
        onChange(options.find((o) => String(o.value) === next)?.value ?? null)
      }
    >
      {options.map((o) => (
        <ToggleGroupItem key={o.value} value={String(o.value)} className="flex-1">
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

export function NumberField({
  label,
  unit,
  value,
  onChange,
  autoFocus,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-sm">{label}</span>
      <span className="flex items-center gap-2">
        <Input
          // Text, not number: iOS with an Italian keyboard types "84,5", which a number
          // input silently discards. parseDecimal accepts both separators.
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          className="h-11 w-24 text-right"
        />
        <span className="w-6 text-sm text-muted-foreground">{unit}</span>
      </span>
    </label>
  );
}

/** Parses a user-typed decimal ("86,4" or "86.4"); empty → null; garbage → undefined. */
export function parseDecimal(text: string): number | null | undefined {
  const t = text.trim().replace(',', '.');
  if (t === '') return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return undefined;
  return Number(t);
}

/**
 * A labelled choice from a short list, on shadcn's Select. `value` "" shows the placeholder,
 * which suits action pickers ("+ Add a meal…") that reset after each pick.
 */
export function OptionSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  placeholder,
  size = 'default',
  className,
}: {
  label: string;
  value: T | '';
  options: Option<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  size?: 'sm' | 'default';
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger aria-label={label} size={size} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A "show more" section on shadcn's Collapsible: closed until the summary is tapped. */
export function Disclosure({
  summary,
  className,
  summaryClassName,
  children,
}: {
  summary: ReactNode;
  className?: string;
  summaryClassName?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible className={cn('group/disclosure', className)}>
      <CollapsibleTrigger
        className={cn(
          'flex items-center gap-1 text-left text-muted-foreground hover:text-foreground',
          summaryClassName,
        )}
      >
        <ChevronRight
          className="size-4 shrink-0 transition-transform group-data-[state=open]/disclosure:rotate-90"
          aria-hidden
        />
        {summary}
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** Placeholder cards while a screen loads; screen readers hear "Loading…". */
export function Loading({ cards = 2 }: { cards?: number }) {
  return (
    <div aria-busy="true" className="space-y-3">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: cards }, (_, i) => (
        <Skeleton key={i} className="h-28 w-full rounded-xl" />
      ))}
    </div>
  );
}

/**
 * Several independent on/off choices (weekdays, meals) on shadcn's ToggleGroup. Reports the
 * option tapped, so each screen keeps its own toggling rules. `fill` spreads one row across
 * the width; otherwise the chips wrap.
 */
export function MultiToggle<T extends string | number>({
  label,
  options,
  value,
  onToggle,
  fill = false,
}: {
  label: string;
  options: Option<T>[];
  value: T[];
  onToggle: (value: T) => void;
  fill?: boolean;
}) {
  const current = value.map(String);
  return (
    <ToggleGroup
      type="multiple"
      aria-label={label}
      variant="outline"
      spacing={1}
      size={fill ? 'default' : 'sm'}
      className={fill ? 'w-full' : 'flex-wrap'}
      value={current}
      onValueChange={(next) => {
        const changed =
          next.find((v) => !current.includes(v)) ?? current.find((v) => !next.includes(v));
        const option = options.find((o) => String(o.value) === changed);
        if (option) onToggle(option.value);
      }}
    >
      {options.map((o) => (
        <ToggleGroupItem key={o.value} value={String(o.value)} className={fill ? 'flex-1' : ''}>
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
