import { Hono } from 'hono';

// ALO-179: tiny endpoint the frontend calls once on first load to decide
// whether to show the EU cookie-consent banner. We trust the
// `cf-ipcountry` header set by Cloudflare's edge — it's not user-supplied
// and matches what GDPR-style "is the visitor in the EEA" logic needs.
//
// Returns `{ country, isEu }`. Cached privately for an hour so a refresh
// inside the SPA doesn't keep hammering the worker.

const EU_EEA_COUNTRIES: ReadonlySet<string> = new Set([
  // EU 27
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
  // EEA non-EU
  'IS',
  'LI',
  'NO',
  // UK (post-Brexit, still GDPR-aligned)
  'GB',
]);

export interface GeoResponse {
  country: string | null;
  isEu: boolean;
}

export function classifyCountry(country: string | null | undefined): GeoResponse {
  if (!country) return { country: null, isEu: false };
  const upper = country.toUpperCase();
  return { country: upper, isEu: EU_EEA_COUNTRIES.has(upper) };
}

export const geoRoutes = new Hono();

geoRoutes.get('/api/geo', (c) => {
  const header = c.req.header('cf-ipcountry') ?? null;
  const body = classifyCountry(header);
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Private cache only — country comes from the user's IP and we
      // shouldn't share a single response across visitors at any shared
      // CDN / proxy layer.
      'Cache-Control': 'private, max-age=3600',
    },
  });
});
