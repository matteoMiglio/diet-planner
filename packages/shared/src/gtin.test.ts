import { describe, expect, it } from 'vitest';
import { canonicalBarcode, expandUpcE, isValidGtin } from './gtin.js';

describe('gtin', () => {
  it('validates check digits', () => {
    expect(isValidGtin('3017620422003')).toBe(true);
    expect(isValidGtin('3017620422004')).toBe(false);
    expect(isValidGtin('96385074')).toBe(true);
    expect(isValidGtin('12345')).toBe(false);
  });

  it('expands UPC-E for each compression pattern', () => {
    expect(expandUpcE('04252614')).toBe('042100005264');
    expect(expandUpcE('01234505')).toBe('012000003455');
    expect(expandUpcE('01234531')).toBe('012300000451');
    expect(expandUpcE('01234543')).toBe('012340000053');
    expect(expandUpcE('01234548')).toBeNull(); // wrong check digit
    expect(expandUpcE('21234505')).toBeNull();
  });

  it('canonicalises the forms of one product to EAN-13', () => {
    expect(canonicalBarcode('036000291452')).toBe('0036000291452');
    expect(canonicalBarcode('0036000291452')).toBe('0036000291452');
    expect(canonicalBarcode('00036000291452')).toBe('0036000291452');
    expect(canonicalBarcode('10036000291459')).toBe('10036000291459');
    expect(canonicalBarcode('04252614')).toBe('0042100005264');
    expect(canonicalBarcode(' 96385074 ')).toBe('96385074');
    expect(canonicalBarcode('3017620422004')).toBeNull();
    expect(canonicalBarcode('abc')).toBeNull();
  });
});
