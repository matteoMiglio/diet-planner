import type { ImportPreviewDto } from '@diet/shared';
import { FileUp } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { BottomSheet } from './BottomSheet';
import { Button, ErrorNote, Disclosure } from './ui';

type Stage =
  | { kind: 'pick' }
  | { kind: 'previewing' }
  | { kind: 'preview'; csv: string; preview: ImportPreviewDto }
  | { kind: 'importing' }
  | { kind: 'done'; result: ImportPreviewDto };

/** Pick a My Tanita CSV, see what it would change, then import. */
export function ImportSheet({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ kind: 'pick' });
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function pick(file: File) {
    setError(null);
    if (file.size > 1024 * 1024)
      return setError('That file is larger than 1 MB; it is not a Tanita export.');
    setStage({ kind: 'previewing' });
    try {
      const csv = await file.text();
      const preview = await api.post<ImportPreviewDto>('/measurements/import?dryRun=1', csv);
      setStage({ kind: 'preview', csv, preview });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setStage({ kind: 'pick' });
    }
  }

  async function confirm(csv: string) {
    setStage({ kind: 'importing' });
    try {
      const result = await api.post<ImportPreviewDto>('/measurements/import', csv);
      setStage({ kind: 'done', result });
      onImported();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setStage({ kind: 'pick' });
    }
  }

  return (
    <BottomSheet title="Import from My Tanita" onClose={onClose}>
      {error && (
        <div className="mb-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {(stage.kind === 'pick' || stage.kind === 'previewing') && (
        <>
          <p className="mb-4 text-sm text-muted-foreground">
            In the My Tanita app, export your measurements as CSV, then choose the file here.
            Readings you already imported are skipped.
          </p>
          <input
            ref={input}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void pick(file);
            }}
          />
          <Button
            className="w-full"
            disabled={stage.kind === 'previewing'}
            onClick={() => input.current?.click()}
          >
            <FileUp size={18} aria-hidden />{' '}
            {stage.kind === 'previewing' ? 'Reading the file…' : 'Choose CSV file'}
          </Button>
        </>
      )}

      {stage.kind === 'preview' && (
        <>
          <Summary result={stage.preview} preview />
          <div className="mt-4 flex gap-3">
            <Button
              className="flex-1"
              disabled={stage.preview.created + stage.preview.merged === 0}
              onClick={() => void confirm(stage.csv)}
            >
              {stage.preview.created + stage.preview.merged === 0
                ? 'Nothing new to import'
                : 'Import'}
            </Button>
            <Button variant="secondary" onClick={() => setStage({ kind: 'pick' })}>
              Other file
            </Button>
          </div>
        </>
      )}

      {stage.kind === 'importing' && <p className="text-sm text-muted-foreground">Importing…</p>}

      {stage.kind === 'done' && (
        <>
          <Summary result={stage.result} />
          <Button className="mt-4 w-full" onClick={onClose}>
            Done
          </Button>
        </>
      )}
    </BottomSheet>
  );
}

function Summary({ result, preview = false }: { result: ImportPreviewDto; preview?: boolean }) {
  const stats = [
    { label: preview ? 'New readings' : 'Added', value: result.created },
    { label: preview ? 'Will replace a quick weigh-in' : 'Merged', value: result.merged },
    { label: 'Already imported', value: result.duplicates },
    { label: 'Skipped (unreadable)', value: result.errors.length },
  ];
  return (
    <div>
      <dl className="grid grid-cols-2 gap-2">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl bg-surface-2 p-3">
            <dt className="text-xs text-muted-foreground">{s.label}</dt>
            <dd className="text-xl font-bold">{s.value}</dd>
          </div>
        ))}
      </dl>
      {result.errors.length > 0 && (
        <Disclosure
          className="mt-3 text-sm"
          summaryClassName="text-muted-foreground"
          summary="Skipped rows"
        >
          <ul className="mt-2 space-y-1">
            {result.errors.slice(0, 20).map((e) => (
              <li key={e.line}>
                Line {e.line}: {e.message}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}
