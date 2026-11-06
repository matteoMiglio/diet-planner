import { CalendarDays, ChartLine, ScanBarcode, Settings, Sun } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Link, NavLink, Outlet } from 'react-router';
import { Toaster } from '@/ui/sonner';

const tabs: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/', label: 'Today', icon: Sun },
  { to: '/plan', label: 'Plan', icon: CalendarDays },
  { to: '/scan', label: 'Scan', icon: ScanBarcode },
  { to: '/progress', label: 'Progress', icon: ChartLine },
];

export function Layout() {
  return (
    <div className="mx-auto flex min-h-full max-w-xl flex-col">
      <header className="flex items-center justify-between px-4 pt-[max(env(safe-area-inset-top),1rem)] pb-2">
        <span className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
          Diet
        </span>
        <Link
          to="/settings"
          aria-label="Settings"
          className="-mr-2 rounded-full p-2 text-muted-foreground hover:bg-surface-2 hover:text-text"
        >
          <Settings size={20} aria-hidden />
        </Link>
      </header>

      <main className="flex-1 px-4 pb-28">
        <Outlet />
      </main>
      {/* At the top: the tab bar covers the bottom of the screen. */}
      <Toaster position="top-center" />

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 border-t border-border bg-surface/90 backdrop-blur pb-[env(safe-area-inset-bottom)]"
      >
        <ul className="mx-auto grid max-w-xl grid-cols-4">
          {tabs.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  `flex flex-col items-center gap-1 py-2.5 text-xs font-medium ${
                    isActive ? 'text-primary' : 'text-muted-foreground hover:text-text'
                  }`
                }
              >
                <Icon size={22} aria-hidden />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
