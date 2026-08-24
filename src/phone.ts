import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/min';

export interface PhoneCountry {
  iso2: CountryCode;
  name: string;
  flag: string;
  cc: string;
  min: number;
  max: number;
  groups: number[];
}

function flagFor(country: CountryCode): string {
  return [...country].map((char) => String.fromCodePoint(127397 + char.charCodeAt(0))).join('');
}

function groupsFor(cc: string): number[] {
  if (cc === '1') return [3, 3, 4];
  if (cc === '7') return [3, 3, 2, 2];
  if (cc === '44' || cc === '49' || cc === '39') return [3, 3, 4];
  return [3, 3, 3, 3, 2];
}

const displayNames = typeof Intl.DisplayNames === 'function'
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null;

function nationalMax(iso2: CountryCode, cc: string): number {
  // E.164: max 15 digits total. Use known lengths for common countries.
  const known: Record<string, number> = {
    US: 10, CA: 10, // +1 NPA-NXX-XXXX
    GB: 10, AU: 9, NZ: 9,
    RU: 10, UA: 9, BY: 9,
    DE: 11, FR: 9, IT: 10, ES: 9, PT: 9,
    JP: 10, KR: 10, CN: 11, IN: 10,
    BR: 11, MX: 10, AR: 10,
    TR: 10, SA: 9, AE: 9, IL: 9,
    PL: 9, NL: 9, BE: 9, SE: 9, NO: 8, DK: 8, FI: 10,
    TH: 9, VN: 9, ID: 10, PH: 10, MY: 9, SG: 8,
    EG: 10, NG: 10, KE: 9, ZA: 9,
    PK: 10, BD: 10, LK: 9, NP: 10,
  };
  return known[iso2] ?? Math.min(10, 15 - cc.length);
}

export const PHONE_COUNTRIES: PhoneCountry[] = getCountries()
  .map((iso2) => {
    const cc = getCountryCallingCode(iso2);
    return {
      iso2,
      name: displayNames?.of(iso2) ?? iso2,
      flag: flagFor(iso2),
      cc,
      min: 4,
      max: nationalMax(iso2, cc),
      groups: groupsFor(cc),
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));
export const COUNTRIES: PhoneCountry[] = PHONE_COUNTRIES;

function byLongestCc(): PhoneCountry[] {
  return [...PHONE_COUNTRIES].sort((a, b) => b.cc.length - a.cc.length);
}

export function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

export function formatNational(national: string, groups: number[]): string {
  let result = '';
  let pos = 0;
  for (const g of groups) {
    if (pos > 0) result += ' ';
    result += national.slice(pos, pos + g);
    pos += g;
  }
  return result.trim();
}

export function detectCountry(digits: string): PhoneCountry | null {
  const d = digitsOnly(digits);
  if (!d) return null;
  const parsed = parsePhoneNumberFromString('+' + d);
  if (parsed?.country) {
    const exact = PHONE_COUNTRIES.find((country) => country.iso2 === parsed.country);
    if (exact) return exact;
  }
  for (const c of byLongestCc()) {
    if (d.startsWith(c.cc)) return c;
  }
  return null;
}

export function validatePhone(raw: string): string | null {
  const normalized = '+' + digitsOnly(raw);
  const parsed = parsePhoneNumberFromString(normalized);
  if (parsed?.isValid()) return parsed.number;
  return null;
}
