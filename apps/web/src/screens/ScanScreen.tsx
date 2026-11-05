import { ScanBarcode } from 'lucide-react';
import { EmptyState } from '../components/EmptyState';
import { ScreenHeader } from '../components/ScreenHeader';

export function ScanScreen() {
  return (
    <>
      <ScreenHeader title="Scan">Rate a product and log it in one go.</ScreenHeader>
      <EmptyState icon={ScanBarcode} title="Scanner not set up yet">
        Barcode scanning and product scores are coming in a later release.
      </EmptyState>
    </>
  );
}
