import { formatClockTime, formatDate } from '../../utils/date-display.ts';
import { useEffect, useState } from 'react';
import { getChinaWeatherHourly, type ChinaWeatherHourlyData } from '../../api/china-day';
import { describeWeather } from './weather-description';

export default function WeatherHourlyPanel({ city, id }: { city: string; id: string }) {
  const [data, setData] = useState<ChinaWeatherHourlyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [windowHour, setWindowHour] = useState(() => Math.floor(Date.now() / 3_600_000));
  useEffect(() => {
    const timer = window.setInterval(() => setWindowHour(Math.floor(Date.now() / 3_600_000)), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    void getChinaWeatherHourly(city, controller.signal, retry > 0).then(value => {
      if (!controller.signal.aborted) setData(value);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '逐小时天气暂时不可用');
    });
    return () => controller.abort();
  }, [city, retry, windowHour]);
  return <section id={id} aria-label="未来24小时天气" className="mt-3 min-w-0 rounded-xl border border-cyan-300/20 bg-cyan-300/[0.04] p-3">
    <h4 className="text-sm font-medium">{city} · 未来24小时</h4>
    <p className="mt-1 text-[11px] text-slate-400">从当前小时起，时间均为北京时间 · 数据来源：Open-Meteo{data && ` · 更新于 ${formatClockTime(data.fetchedAt, { timeZone: 'Asia/Shanghai' })}`}</p>
    {!data && !error && <p role="status" className="mt-3 text-sm text-slate-300">正在读取逐小时天气…</p>}
    {error && <div role="alert" className="mt-3 text-xs text-rose-200">{error}<button type="button" onClick={() => setRetry(value => value + 1)} className="ml-2 underline">重试</button></div>}
    {data && <div tabIndex={0} role="region" aria-label="逐小时温度、降水概率和天气，可左右滑动" className="mt-3 overflow-x-auto pb-2">
      <div className="flex gap-2">{data.hours.map(hour => <div key={hour.time} className="w-[92px] shrink-0 rounded-lg border border-white/10 bg-slate-950/40 p-2 text-center">
        <p className="text-[10px] text-slate-400">{formatDate(hour.time.slice(0, 10), { short: true })}</p>
        <p className="mt-1 text-xs font-medium">{hour.time.slice(11, 16)}</p>
        <p className="mt-2 text-sm tabular-nums">{hour.temperatureC === null ? '—' : `${Math.round(hour.temperatureC)}℃`}</p>
        <p className="mt-2 text-xs text-slate-300">{describeWeather(hour.weatherCode)}</p>
        <p className="mt-2 whitespace-nowrap text-[10px] text-sky-300">降水概率 {hour.precipitationProbabilityPercent === null ? '—' : `${hour.precipitationProbabilityPercent}%`}</p>
      </div>)}</div>
    </div>}
  </section>;
}
