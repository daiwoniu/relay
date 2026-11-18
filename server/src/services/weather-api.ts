import { createWeatherTransport } from './weather-transport.js';

const weatherTransport = createWeatherTransport();

export class ChinaDayInputError extends Error {}

export function boundedWeatherFetch(fetcher: typeof fetch): typeof fetch {
  const deadline = AbortSignal.timeout(24_000);
  const send = fetcher === fetch ? weatherTransport : fetcher;
  return (input, init) => send(input, { ...init,
    signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline });
}

export class WeatherUpstreamError extends Error {
  constructor(source: string, cause: unknown) {
    const error = cause as { name?: string; code?: unknown; cause?: { name?: string; code?: unknown } };
    const rawCode = error?.cause?.code ?? error?.code;
    const code = typeof rawCode === 'string' ? rawCode : '';
    const reason = error?.name === 'TimeoutError' || error?.cause?.name === 'TimeoutError' || code === 'ETIMEDOUT' || code.includes('TIMEOUT') ? '连接超时'
      : code === 'CERT_HAS_EXPIRED' ? '证书已过期'
      : code === 'ENOTFOUND' ? '域名解析失败' : '连接失败或数据异常';
    super(`${source}${reason}，请稍后重试或检查服务器网络`, { cause });
  }
}

export async function readWeatherJson(fetcher: typeof fetch, url: string): Promise<any> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(8_000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export async function coordinatesFor(fetcher: typeof fetch, city: string, latitude: number | null, longitude: number | null) {
  if (latitude !== null && longitude !== null && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    && (latitude !== 0 || longitude !== 0)) return { latitude, longitude };
  const normalized = city.replace(/市$/, '');
  // Full city names avoid matching a same-named village (e.g. 青岛 near 大连).
  const names = /(?:市|区|县|旗|盟|自治州)$/.test(city) ? [city, normalized] : [`${city}市`, city];
  for (const name of new Set(names)) {
    const query = new URLSearchParams({ name, count: '10', language: 'zh', countryCode: 'CN' });
    const body = await readWeatherJson(fetcher, `https://geocoding-api.open-meteo.com/v1/search?${query}`);
    const candidates = Array.isArray(body?.results) ? body.results : [];
    const place = candidates.find((item: any) => item.country_code === 'CN'
      && item.feature_code !== 'ADM1' && String(item.name).replace(/市$/, '') === normalized
      && numberOrNull(item.latitude) !== null && numberOrNull(item.longitude) !== null
      && Math.abs(item.latitude) <= 90 && Math.abs(item.longitude) <= 180);
    if (place) return { latitude: place.latitude as number, longitude: place.longitude as number };
  }
  throw new ChinaDayInputError(`未找到 ${city} 的天气坐标，请输入具体城市或区县（如兰州市、酒泉市），不支持仅按省份查询`);
}

export function weatherDescription(code: unknown): string | null {
  if (typeof code !== 'number' || !Number.isFinite(code)) return null;
  if (code === 0) return '晴';
  if (code === 1) return '大部晴朗';
  if (code === 2) return '多云';
  if (code === 3) return '阴';
  if (code === 45 || code === 48) return '雾';
  if (code >= 51 && code <= 57) return '毛毛雨';
  if (code >= 61 && code <= 67) return '雨';
  if (code >= 71 && code <= 77) return '雪';
  if (code >= 80 && code <= 82) return '阵雨';
  if (code === 85 || code === 86) return '阵雪';
  if (code >= 95 && code <= 99) return '雷雨';
  return null;
}

export async function openMeteoCurrent(fetcher: typeof fetch,
  location: { city: string; latitude: number | null; longitude: number | null }, date: string) {
  try {
    const coords = await coordinatesFor(fetcher, location.city, location.latitude, location.longitude);
    const query = new URLSearchParams({ latitude: String(coords.latitude), longitude: String(coords.longitude),
      current: 'temperature_2m,precipitation,weather_code', daily: 'weather_code,temperature_2m_max,temperature_2m_min',
      forecast_days: '1', timezone: 'Asia/Shanghai' });
    const body = await readWeatherJson(fetcher, `https://api.open-meteo.com/v1/forecast?${query}`);
    const current = body?.current;
    const temperatureC = numberOrNull(current?.temperature_2m);
    if (temperatureC === null || typeof current?.time !== 'string' || !current.time.startsWith(`${date}T`)) {
      throw new Error('Current weather missing or stale');
    }
    const index = Array.isArray(body.daily?.time) ? body.daily.time.indexOf(date) : -1;
    const description = weatherDescription(current.weather_code);
    return { stationName: location.city, observedAt: current.time, temperatureC,
      precipitationMm: numberOrNull(current.precipitation),
      forecast: { dayText: description, nightText: description,
        highC: index < 0 ? null : numberOrNull(body.daily.temperature_2m_max?.[index]),
        lowC: index < 0 ? null : numberOrNull(body.daily.temperature_2m_min?.[index]) }, source: 'open-meteo' as const };
  } catch (error) {
    if (error instanceof ChinaDayInputError) throw error;
    throw new WeatherUpstreamError('Open-Meteo 实况天气', error);
  }
}
