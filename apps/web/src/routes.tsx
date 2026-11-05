import type { RouteObject } from 'react-router';
import { Layout } from './components/Layout';
import { CheckinScreen } from './screens/CheckinScreen';
import { PlanScreen } from './screens/PlanScreen';
import { ProgressScreen } from './screens/ProgressScreen';
import { ScanScreen } from './screens/ScanScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { TodayScreen } from './screens/TodayScreen';

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <TodayScreen /> },
      { path: 'plan', element: <PlanScreen /> },
      { path: 'scan', element: <ScanScreen /> },
      { path: 'progress', element: <ProgressScreen /> },
      { path: 'settings', element: <SettingsScreen /> },
      { path: 'checkin', element: <CheckinScreen /> },
      { path: '*', element: <TodayScreen /> },
    ],
  },
];
