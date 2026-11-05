/**
 * Retail barcodes. The same product can be read as UPC-A (12 digits), EAN-13 with a leading
 * zero, GTIN-14 with a leading zero, or UPC-E (8 digits, zeros suppressed), so codes are stored
 * and looked up in one canonical form: EAN-13 for all of those, EAN-8 kept as it is.
 */

/** GTIN-8/12/13/14 with a valid check digit. */
export function isValidGtin(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** UPC-E (number system 0 or 1) expanded to UPC-A; null when it isn't one. */
export function expandUpcE(code: string): string | null {
  if (!/^[01]\d{7}$/.test(code)) return null;
  const ns = code[0]!;
  const d = code.slice(1, 7);
  const check = code[7]!;
  const last = Number(d[5]);
  let body: string;
  if (last <= 2) body = `${d[0]}${d[1]}${d[5]}0000${d[2]}${d[3]}${d[4]}`;
  else if (last === 3) body = `${d.slice(0, 3)}00000${d[3]}${d[4]}`;
  else if (last === 4) body = `${d.slice(0, 4)}00000${d[4]}`;
  else body = `${d.slice(0, 5)}0000${d[5]}`;
  const upcA = `${ns}${body}${check}`;
  return isValidGtin(upcA) ? upcA : null;
}

/** The canonical form of a retail barcode, or null when it isn't a valid one. */
export function canonicalBarcode(raw: string): string | null {
  const code = raw.trim();
  if (code.length === 8) {
    // A valid EAN-8 wins: the two forms overlap and EAN-8 is the European one.
    if (isValidGtin(code)) return code;
    const upcA = expandUpcE(code);
    return upcA ? `0${upcA}` : null;
  }
  if (!isValidGtin(code)) return null;
  if (code.length === 12) return `0${code}`;
  if (code.length === 14 && code.startsWith('0')) return code.slice(1);
  return code;
}
