import type { ReactNode } from 'react';

export function ScreenHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-4">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      {children ? <p className="mt-0.5 text-sm text-muted-foreground">{children}</p> : null}
    </div>
  );
}
