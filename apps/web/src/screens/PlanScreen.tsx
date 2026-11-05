import { CalendarDays } from 'lucide-react';
import { EmptyState } from '../components/EmptyState';
import { ScreenHeader } from '../components/ScreenHeader';

export function PlanScreen() {
  return (
    <>
      <ScreenHeader title="Plan">Targets, the week, and proposals to review.</ScreenHeader>
      <EmptyState icon={CalendarDays} title="Nothing planned">
        Set up a phase and its targets to start building the week.
      </EmptyState>
    </>
  );
}
