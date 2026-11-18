import { isIP } from 'node:net';
import { ChinaDayInputError, chinaToday, locationFor } from './china-day.js';
import { boundedWeatherFetch, coordinatesFor, numberOrNull, readWeatherJson, WeatherUpstreamError } from './weather-api.js';

export interface ChinaWeatherRangeOptions {
  city?: string;
  ip?: string;
  date?: string;
  fetcher?: typeof fetch;
}

export async function buildChinaWeatherRange({ city, ip, date = chinaToday(), fetcher = fetch }: ChinaWeatherRangeOptions = {}) {
  if (city !== undefined && (typeof city !== 'string' || !city.trim() || city.length > 30)) throw new ChinaDayInputError('无效城市名称');
  if (ip && !isIP(ip)) throw new ChinaDayInputError('无效 IP 地址');
  if (city && ip) throw new ChinaDayInputError('city 和 ip 只能使用一个');
  // Bound the entire provider chain below the client's 30-second request timeout.
  fetcher = boundedWeatherFetch(fetcher);
  const location = city
    ? { city: city.trim(), latitude: null, longitude: null }
    : await locationFor(fetcher, ip).catch((error) => { throw new WeatherUpstreamError('IP 属地接口', error); });
  try {
    const coords = await coordinatesFor(fetcher, location.city, location.latitude, location.longitude);
    const query = new URLSearchParams({
      latitude: String(coords.latitude), longitude: String(coords.longitude),
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max',
      timezone: 'Asia/Shanghai', past_days: '3', forecast_days: '8',
    });
    const body = await readWeatherJson(fetcher, `https://api.open-meteo.com/v1/forecast?${query}`);
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
  } catch (error) {
    if (error instanceof ChinaDayInputError) throw error;
    throw new WeatherUpstreamError('Open-Meteo 日预报', error);
  }
}
