import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-border bg-surface p-4 ${className}`}>
      {children}
    </section>
  );
}

export function SectionTitle({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2 id={id} className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
      {children}
    </h2>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
};

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  const styles = {
    primary: 'bg-accent text-bg hover:opacity-90',
    secondary: 'bg-surface-2 text-text hover:bg-border',
    ghost: 'text-accent hover:bg-accent-soft',
    danger: 'text-danger hover:bg-surface-2',
  }[variant];
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition disabled:opacity-50 ${styles} ${className}`}
    />
  );
}

export interface Option<T extends string | number> {
  value: T;
  label: string;
}

/** A row of mutually exclusive choices. Tapping the selected one again clears it. */
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
    <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-xl bg-surface-2 p-1">
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(selected ? null : o.value)}
            className={`min-h-10 flex-1 rounded-lg px-2 text-sm font-medium transition ${
              selected ? 'bg-surface text-text shadow-sm' : 'text-muted hover:text-text'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-xl bg-surface-2 px-3 py-2 text-sm text-danger">
      {children}
    </p>
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
        <input
          // Text, not number: iOS with an Italian keyboard types "84,5", which a number
          // input silently discards. parseDecimal accepts both separators.
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          className="w-24 rounded-xl border border-border bg-bg px-3 py-2 text-right text-base outline-none focus:border-accent"
        />
        <span className="w-6 text-sm text-muted">{unit}</span>
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
