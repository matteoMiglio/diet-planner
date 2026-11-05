import { Utensils } from 'lucide-react';
import { EmptyState } from '../components/EmptyState';
import { ScreenHeader } from '../components/ScreenHeader';

const dateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

export function TodayScreen() {
  return (
    <>
      <ScreenHeader title="Today">{dateFormat.format(new Date())}</ScreenHeader>
      <EmptyState icon={Utensils} title="No plan yet">
        Your meals for the day will show up here once a plan is active.
      </EmptyState>
    </>
  );
}
