import { isIP } from 'node:net';
import { ChinaDayInputError, locationFor } from './china-day.js';
import { boundedWeatherFetch, coordinatesFor, WeatherUpstreamError } from './weather-api.js';

function numberIn(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

export async function buildChinaWeatherHourly({ city, ip, fetcher = fetch, now = Date.now() }: {
  city?: string; ip?: string; fetcher?: typeof fetch; now?: number;
} = {}) {
  if (city !== undefined && (typeof city !== 'string' || !city.trim() || city.length > 30)) throw new ChinaDayInputError('无效城市名称');
  if (ip && !isIP(ip)) throw new ChinaDayInputError('无效 IP 地址');
  if (city && ip) throw new ChinaDayInputError('city 和 ip 只能使用一个');
  fetcher = boundedWeatherFetch(fetcher);
  const location = city ? { city: city.trim(), latitude: null, longitude: null }
    : await locationFor(fetcher, ip).catch(error => { throw new WeatherUpstreamError('IP 属地接口', error); });
  try {
    const coords = await coordinatesFor(fetcher, location.city, location.latitude, location.longitude);
    const start = Math.floor(now / 3_600_000) * 3_600_000;
    const localHour = (value: number) => new Date(value + 8 * 3_600_000).toISOString().slice(0, 16);
    const query = new URLSearchParams({ latitude: String(coords.latitude), longitude: String(coords.longitude),
      hourly: 'temperature_2m,precipitation_probability,weather_code', start_hour: localHour(start),
      end_hour: localHour(start + 23 * 3_600_000), timezone: 'Asia/Shanghai' });
    const response = await fetcher(`https://api.open-meteo.com/v1/forecast?${query}`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const hourly = (await response.json())?.hourly;
    if (![hourly?.time, hourly?.temperature_2m, hourly?.precipitation_probability, hourly?.weather_code]
      .every(values => Array.isArray(values) && values.length === 24)) throw new Error('Incomplete hourly forecast');
    const times: unknown[] = hourly.time;
    const hours = times.map((time, index) => {
      if (typeof time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(time)
        || Date.parse(`${time}+08:00`) !== start + index * 3_600_000) throw new Error('Hourly forecast time mismatch');
      return { time, temperatureC: numberIn(hourly.temperature_2m?.[index], -100, 100),
        precipitationProbabilityPercent: numberIn(hourly.precipitation_probability?.[index], 0, 100),
        weatherCode: numberIn(hourly.weather_code?.[index], 0, 99) };
    });
    return { location: { city: location.city, ...coords }, hours, source: 'open-meteo' as const };
  } catch (error) {
    if (error instanceof ChinaDayInputError) throw error;
    throw new WeatherUpstreamError('Open-Meteo 逐小时天气', error);
  }
}
