import { ChartLine } from 'lucide-react';
import { EmptyState } from '../components/EmptyState';
import { ScreenHeader } from '../components/ScreenHeader';

export function ProgressScreen() {
  return (
    <>
      <ScreenHeader title="Progress">Weight trend, waist, and how the phase is going.</ScreenHeader>
      <EmptyState icon={ChartLine} title="No measurements yet">
        Import your Tanita export to see the trend.
      </EmptyState>
    </>
  );
}
