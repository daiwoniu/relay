import { requestJson } from './client';

export interface ChinaDayData {
  date: string;
  location?: { city: string } | null;
  calendar: {
    lunarDate?: string;
    solarFestivals: string[];
    lunarFestivals: string[];
    solarTerm: string | null;
    holidayArrangement: { name: string; isOffDay: boolean } | null;
  };
  weather: {
    observedAt?: string | null;
    stationName?: string | null;
    precipitationMm: number | null;
    temperatureC: number | null;
    forecast: { dayText: string | null; nightText: string | null } | null;
  } | null;
}

export function getChinaDay(signal?: AbortSignal): Promise<ChinaDayData> {
  return requestJson<ChinaDayData>('/api/public/tools/china-day', { signal, timeoutMs: 30_000, cache: 'no-store', notifyUnauthorized: false });
}

export interface ChinaCalendarMonthData {
  year: number;
  month: number;
  fetchedAt: number;
  days: Array<{
    date: string;
    inMonth: boolean;
    lunarDate: string;
    solarFestivals: string[];
    lunarFestivals: string[];
    solarTerm: string | null;
    holidayArrangement: { name: string; isOffDay: boolean } | null;
  }>;
  warnings: string[];
}

export interface ChinaWeatherRangeData {
  date: string;
  fetchedAt: number;
  location: { city: string; latitude: number; longitude: number };
  days: Array<{
    date: string;
    kind: 'past' | 'today' | 'forecast';
    weatherCode: number | null;
    highC: number | null;
    lowC: number | null;
    precipitationMm: number | null;
    precipitationProbabilityPercent: number | null;
  }>;
  source: 'open-meteo';
}

export function getChinaCalendarMonth(year: number, month: number, signal?: AbortSignal, refresh = false): Promise<ChinaCalendarMonthData> {
  const query = new URLSearchParams({ year: String(year), month: String(month) });
  if (refresh) query.set('refresh', '1');
  return requestJson<ChinaCalendarMonthData>(`/api/public/tools/china-day/calendar?${query}`, { signal, timeoutMs: 30_000, cache: 'no-store', notifyUnauthorized: false });
}

export function getChinaWeatherRange(city?: string, signal?: AbortSignal, refresh = false): Promise<ChinaWeatherRangeData> {
  const query = new URLSearchParams();
  if (city) query.set('city', city);
  if (refresh) query.set('refresh', '1');
  return requestJson<ChinaWeatherRangeData>(`/api/public/tools/china-day/weather${query.size ? `?${query}` : ''}`, { signal, timeoutMs: 30_000, cache: 'no-store', notifyUnauthorized: false });
}

export interface ChinaWeatherHourlyData {
  location: { city: string; latitude: number; longitude: number };
  fetchedAt: number;
  source: 'open-meteo';
  hours: Array<{ time: string; temperatureC: number | null; precipitationProbabilityPercent: number | null; weatherCode: number | null }>;
}

export function getChinaWeatherHourly(city: string, signal?: AbortSignal, refresh = false): Promise<ChinaWeatherHourlyData> {
  const query = new URLSearchParams({ city });
  if (refresh) query.set('refresh', '1');
  return requestJson<ChinaWeatherHourlyData>(`/api/public/tools/china-day/hourly?${query}`, { signal, timeoutMs: 30_000, cache: 'no-store', notifyUnauthorized: false });
}
