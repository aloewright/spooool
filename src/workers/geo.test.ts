import { describe, expect, it } from 'vitest';
import { classifyCountry, geoRoutes, type GeoResponse } from './geo';

describe('classifyCountry', () => {
  it('returns null country when no header is set', () => {
    expect(classifyCountry(undefined)).toEqual<GeoResponse>({ country: null, isEu: false });
    expect(classifyCountry(null)).toEqual<GeoResponse>({ country: null, isEu: false });
    expect(classifyCountry('')).toEqual<GeoResponse>({ country: null, isEu: false });
  });

  it('flags EU/EEA/UK countries as isEu=true', () => {
    expect(classifyCountry('DE')).toEqual<GeoResponse>({ country: 'DE', isEu: true });
    expect(classifyCountry('NO')).toEqual<GeoResponse>({ country: 'NO', isEu: true });
    expect(classifyCountry('GB')).toEqual<GeoResponse>({ country: 'GB', isEu: true });
  });

  it('flags non-EU countries as isEu=false but echoes the country', () => {
    expect(classifyCountry('US')).toEqual<GeoResponse>({ country: 'US', isEu: false });
    expect(classifyCountry('JP')).toEqual<GeoResponse>({ country: 'JP', isEu: false });
  });

  it('uppercases lower-case input', () => {
    expect(classifyCountry('de')).toEqual<GeoResponse>({ country: 'DE', isEu: true });
  });
});

describe('GET /api/geo', () => {
  it('returns isEu=true when cf-ipcountry is in the EEA', async () => {
    const res = await geoRoutes.fetch(
      new Request('http://localhost/api/geo', { headers: { 'cf-ipcountry': 'FR' } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ country: 'FR', isEu: true });
    expect(res.headers.get('Cache-Control')).toMatch(/private/);
  });

  it('returns isEu=false when cf-ipcountry is non-EU', async () => {
    const res = await geoRoutes.fetch(
      new Request('http://localhost/api/geo', { headers: { 'cf-ipcountry': 'US' } }),
    );
    expect(await res.json()).toEqual({ country: 'US', isEu: false });
  });

  it('returns null country when the header is missing (e.g. local dev)', async () => {
    const res = await geoRoutes.fetch(new Request('http://localhost/api/geo'));
    expect(await res.json()).toEqual({ country: null, isEu: false });
  });
});
