import { formatClockTime, formatDate } from '../../utils/date-display.ts';
import { useEffect, useRef, useState } from 'react';
import { getChinaWeatherHourly, type ChinaWeatherHourlyData } from '../../api/china-day';
import { describeWeather } from './weather-description';

export default function WeatherHourlyPanel({ city, id, surface }: { city: string; id: string; surface: 'tools' | 'workbench' }) {
  const [data, setData] = useState<ChinaWeatherHourlyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const handledRetry = useRef(0);
  const [windowHour, setWindowHour] = useState(() => Math.floor(Date.now() / 3_600_000));
  useEffect(() => {
    const timer = window.setInterval(() => setWindowHour(Math.floor(Date.now() / 3_600_000)), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    const force = retry !== handledRetry.current;
    handledRetry.current = retry;
    void getChinaWeatherHourly(city, controller.signal, force, surface).then(value => {
      if (!controller.signal.aborted) setData(value);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '逐小时天气暂时不可用');
    });
    return () => controller.abort();
  }, [city, retry, surface, windowHour]);
  return <section id={id} aria-label="未来24小时天气" className="weather-hourly mt-3 min-w-0 rounded-xl border border-cyan-300/20 bg-cyan-300/[0.04] p-3">
    <h4 className="weather-hourly-title">{city} · 未来 24 小时</h4>
    <p className="weather-hourly-meta mt-1 text-xs text-slate-400">北京时间 · Open-Meteo{data && ` · 更新于 ${formatClockTime(data.fetchedAt, { timeZone: 'Asia/Shanghai' })}`}</p>
    {!data && !error && <p role="status" className="mt-3 text-sm text-slate-300">正在读取逐小时天气…</p>}
    {error && <div role="alert" className="mt-3 text-xs text-rose-200">{error}<button type="button" onClick={() => setRetry(value => value + 1)} className="ml-2 underline">重试</button></div>}
    {data && <div tabIndex={0} role="region" aria-label="逐小时温度、降水概率和天气，可左右滑动" className="weather-hourly-scroll mt-3 overflow-x-auto pb-2">
      <ul className="flex gap-2">{data.hours.map((hour, index) => <li key={hour.time} className="weather-hourly-card shrink-0 rounded-lg border border-white/10 bg-slate-950/40 p-2"
        data-first-hour={index === 0 || undefined}>
        <p className="weather-hourly-meta text-xs text-slate-400">{formatDate(hour.time.slice(0, 10), { short: true })}</p>
        <p className="weather-hourly-time mt-1 text-sm font-medium">{hour.time.slice(11, 16)}</p>
        <p className="weather-hourly-temperature mt-2 tabular-nums">{hour.temperatureC === null ? '—' : `${Math.round(hour.temperatureC)}℃`}</p>
        <p className="mt-1 text-xs text-slate-300">{describeWeather(hour.weatherCode)}</p>
        <p className="weather-hourly-rain mt-2 whitespace-nowrap text-xs text-sky-300">降水概率 {hour.precipitationProbabilityPercent === null ? '—' : `${hour.precipitationProbabilityPercent}%`}</p>
      </li>)}</ul>
    </div>}
  </section>;
}
