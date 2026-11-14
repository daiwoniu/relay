import { isIP } from 'node:net';
import { ChinaDayInputError, chinaToday, locationFor } from './china-day.js';

const TIMEOUT_MS = 8_000;

export interface ChinaWeatherRangeOptions {
  city?: string;
  ip?: string;
  date?: string;
  fetcher?: typeof fetch;
}

async function readJson(fetcher: typeof fetch, url: string): Promise<any> {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function coordinatesFor(fetcher: typeof fetch, city: string, latitude: number | null, longitude: number | null) {
  if (latitude !== null && longitude !== null && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    && (latitude !== 0 || longitude !== 0)) return { latitude, longitude };
  const normalized = city.replace(/市$/, '');
  // GeoNames may index only the full Chinese city name (e.g. 酒泉市).
  // Prefer the full city name: 青岛 alone can resolve to a village near 大连.
  const names = /(?:市|区|县|旗|盟|自治州)$/.test(city) ? [city, normalized] : [`${city}市`, city];
  for (const name of new Set(names)) {
    const query = new URLSearchParams({ name, count: '10', language: 'zh', countryCode: 'CN' });
    const body = await readJson(fetcher, `https://geocoding-api.open-meteo.com/v1/search?${query}`);
    const candidates = Array.isArray(body?.results) ? body.results : [];
    const place = candidates.find((item: any) => item.country_code === 'CN'
      && item.feature_code !== 'ADM1' && String(item.name).replace(/市$/, '') === normalized
      && numberOrNull(item.latitude) !== null && numberOrNull(item.longitude) !== null
      && Math.abs(item.latitude) <= 90 && Math.abs(item.longitude) <= 180);
    if (place) return { latitude: place.latitude as number, longitude: place.longitude as number };
  }
  throw new ChinaDayInputError(`未找到 ${city} 的天气坐标，请输入具体城市或区县（如兰州市、酒泉市），不支持仅按省份查询`);
}

export async function buildChinaWeatherRange({ city, ip, date = chinaToday(), fetcher = fetch }: ChinaWeatherRangeOptions = {}) {
  if (city !== undefined && (typeof city !== 'string' || !city.trim() || city.length > 30)) throw new ChinaDayInputError('无效城市名称');
  if (ip && !isIP(ip)) throw new ChinaDayInputError('无效 IP 地址');
  if (city && ip) throw new ChinaDayInputError('city 和 ip 只能使用一个');
  const location = city
    ? { city: city.trim(), latitude: null, longitude: null }
    : await locationFor(fetcher, ip);
  const coords = await coordinatesFor(fetcher, location.city, location.latitude, location.longitude);
  const query = new URLSearchParams({
    latitude: String(coords.latitude), longitude: String(coords.longitude),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max',
    timezone: 'Asia/Shanghai', past_days: '3', forecast_days: '8',
  });
  const body = await readJson(fetcher, `https://api.open-meteo.com/v1/forecast?${query}`);
  const daily = body?.daily;
  if (!Array.isArray(daily?.time)) throw new Error('逐日天气数据格式无效');
  const days = (daily.time as unknown[]).map((value, index) => ({
    date: String(value), kind: String(value) < date ? 'past' as const : String(value) === date ? 'today' as const : 'forecast' as const,
    weatherCode: numberOrNull(daily.weather_code?.[index]),
    highC: numberOrNull(daily.temperature_2m_max?.[index]),
    lowC: numberOrNull(daily.temperature_2m_min?.[index]),
    precipitationMm: numberOrNull(daily.precipitation_sum?.[index]),
    precipitationProbabilityPercent: numberOrNull(daily.precipitation_probability_max?.[index]),
  }));
  return { date, location: { city: location.city, ...coords }, days, source: 'open-meteo' as const };
}
