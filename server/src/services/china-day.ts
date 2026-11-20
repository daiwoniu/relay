import { isIP } from 'node:net';
import { boundedWeatherFetch, ChinaDayInputError, openMeteoCurrent } from './weather-api.js';
export { ChinaDayInputError } from './weather-api.js';
import lunar from 'lunar-javascript';

const { Solar } = lunar;
const TIMEOUT_MS = 8_000;

export interface ChinaDayOptions {
  ip?: string;
  city?: string;
  date?: string;
  fetcher?: typeof fetch;
}

export function chinaToday(): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const checked = new Date(Date.UTC(year, month - 1, day));
  return checked.getUTCFullYear() === year && checked.getUTCMonth() === month - 1 && checked.getUTCDate() === day;
}

async function readJson(fetcher: typeof fetch, url: string): Promise<any> {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function calendarFor(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  const solar = Solar.fromYmd(year, month, day);
  const lunarDate = solar.getLunar();
  return {
    lunarDate: lunarDate.toString(),
    solarFestivals: solar.getFestivals() as string[],
    lunarFestivals: lunarDate.getFestivals() as string[],
    solarTerm: (lunarDate.getJieQi() || null) as string | null,
    holidayArrangement: null as { name: string; isOffDay: boolean } | null,
  };
}

export async function locationFor(fetcher: typeof fetch, ip?: string) {
  const url = ip
    ? `https://api.live.bilibili.com/ip_service/v1/ip_service/get_ip_addr?ip=${encodeURIComponent(ip)}`
    : 'https://api.bilibili.com/x/web-interface/zone';
  const body = await readJson(fetcher, url);
  const target = ip ? `访客 IPv${isIP(ip)}` : '服务器出口 IP';
  if (body?.code !== 0) {
    // Report only a numeric provider code, never its raw payload or the visitor's IP.
    const code = typeof body?.code === 'number' && Number.isFinite(body.code) ? String(body.code) : '未知';
    throw new Error(`地区接口请求失败（${target}，错误码 ${code}）`);
  }
  const city = typeof body.data?.city === 'string' ? body.data.city.trim() : '';
  if (!city) throw new Error(`地区接口查询成功但未返回城市（${target}）`);
  const latitude = Number(body.data.latitude);
  const longitude = Number(body.data.longitude);
  return {
    country: body.data.country || null,
    province: body.data.province || null,
    city,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    source: ip ? 'bilibili-ip' as const : 'bilibili-server-ip' as const,
  };
}

export async function buildChinaDay({ ip, city, date = chinaToday(), fetcher = fetch }: ChinaDayOptions = {}) {
  if (ip && !isIP(ip)) throw new ChinaDayInputError('无效 IP 地址');
  if (city !== undefined && (typeof city !== 'string' || !city.trim() || city.length > 30)) {
    throw new ChinaDayInputError('无效城市名称');
  }
  if (!validDate(date)) throw new ChinaDayInputError('日期必须是有效的 YYYY-MM-DD');
  fetcher = boundedWeatherFetch(fetcher);

  const calendar = calendarFor(date);
  const warnings: string[] = [];
  let location: Awaited<ReturnType<typeof locationFor>> | {
    country: string; province: null; city: string; latitude: null; longitude: null; source: 'manual';
  } | null = null;
  let weather: Awaited<ReturnType<typeof openMeteoCurrent>> | null = null;

  if (city) {
    location = { country: '中国', province: null, city: city.trim(), latitude: null, longitude: null, source: 'manual' };
  } else {
    try { location = await locationFor(fetcher, ip); }
    catch (error) { warnings.push(`地区获取失败：${error instanceof Error ? error.message : String(error)}`); }
  }

  if (location) {
    try { weather = await openMeteoCurrent(fetcher, location, date); }
    catch (error) { warnings.push(`天气获取失败：${error instanceof Error ? error.message : String(error)}`); }
  }

  try {
    const year = Number(date.slice(0, 4));
    const body = await readJson(fetcher,
      `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`);
    if (body?.year !== year || !Array.isArray(body.days)) throw new Error('年度数据格式无效');
    const arrangement = body.days.find((item: any) => item.date === date);
    if (arrangement) calendar.holidayArrangement = {
      name: String(arrangement.name), isOffDay: arrangement.isOffDay === true,
    };
  } catch (error) {
    warnings.push(`放假数据获取失败：${error instanceof Error ? error.message : String(error)}`);
  }

  return { date, location, weather, calendar, warnings };
}
