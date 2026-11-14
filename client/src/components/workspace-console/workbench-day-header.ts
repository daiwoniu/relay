import type { ChinaDayData } from '../../api/china-day';

export function buildWorkbenchDayHeader(date: string, day: ChinaDayData | null, hour: number) {
  const [year, month, dayOfMonth] = date.split('-').map(Number);
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long', timeZone: 'Asia/Shanghai' })
    .format(new Date(Date.UTC(year, month - 1, dayOfMonth, 12)));
  const current = day?.date === date ? day : null;
  const calendar = current?.calendar;
  const lunar = calendar?.lunarDate?.replace(/^.*?年/, '').trim();
  const festival = calendar?.solarFestivals[0] || calendar?.lunarFestivals[0]
    || calendar?.solarTerm || calendar?.holidayArrangement?.name;
  const arrangement = calendar?.holidayArrangement;
  const occasion = festival
    ? `${festival}${arrangement ? ` · ${arrangement.isOffDay ? '休假' : '调休上班'}` : ''}`
    : null;
  const city = current?.location?.city?.trim();
  const weather = current?.weather;
  const temperature = typeof weather?.temperatureC === 'number' && Number.isFinite(weather.temperatureC)
    ? `${Math.round(weather.temperatureC)}℃` : null;
  const condition = hour >= 18 ? weather?.forecast?.nightText : weather?.forecast?.dayText;
  const weatherDetail = [temperature, condition].filter(Boolean).join(' · ');

  return {
    date: `${month}月${dayOfMonth}日`,
    weekday,
    lunar: lunar ? `农历${lunar}` : null,
    occasion,
    weather: city && weatherDetail ? `${city}  ${weatherDetail}` : null,
  };
}
