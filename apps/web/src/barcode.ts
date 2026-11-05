/**
 * Barcode reading with zxing-wasm. The WebAssembly file is bundled and served by the app
 * (the library would otherwise fetch it from a CDN, which the CSP blocks).
 */
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

let prepared = false;
function prepare() {
  if (prepared) return;
  prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) =>
        path.endsWith('.wasm') ? wasmUrl : prefix + path,
    },
  });
  prepared = true;
}

/** Reads a retail barcode (EAN-13/8, UPC-A/E) from a video frame; null if none is found. */
export async function readRetailBarcode(frame: ImageData): Promise<string | null> {
  prepare();
  const results = await readBarcodes(frame, {
    formats: ['EAN13', 'EAN8', 'UPCA', 'UPCE'],
    tryHarder: true,
    maxNumberOfSymbols: 1,
  });
  const hit = results.find((r) => r.isValid && /^\d{8,14}$/.test(r.text));
  return hit?.text ?? null;
}
