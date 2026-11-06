import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}

export function EmptyState({ icon: Icon, title, children }: EmptyStateProps) {
  return (
    <div className="mt-10 flex flex-col items-center rounded-2xl border border-dashed border-border px-6 py-12 text-center">
      <div className="mb-4 rounded-full bg-primary-soft p-3 text-primary">
        <Icon size={24} aria-hidden />
      </div>
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
