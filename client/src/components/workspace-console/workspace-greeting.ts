import type { ChinaDayData } from '../../api/china-day';

export const WORKSPACE_GREETING_STORAGE_KEY = 'relay.workspace.greeting.last';
export const CHINA_DAY_CACHE_KEY = 'relay.workspace.china-day';
const CHINA_DAY_CACHE_MS = 10 * 60_000;

const everydayDay = [
  '茶还热着，正好喝两口。',
  '今天有什么想吃的？晚饭可以早点惦记。',
  '窗外有点动静，抬头看一眼也挺好。',
  '事情一件件来，日子也一天天过。',
  '偶尔发会儿呆，脑子反而清楚。',
  '刚想起的小事，记下来就不用一直惦记。',
  '和家里人聊两句，心情会松快不少。',
  '今天要是有空，出去走一小段路。',
  '忙归忙，饭还是要吃香一点。',
  '手边这杯水，什么时候续一杯？',
  '不用把每个空当都安排满。',
  '这一会儿的清静，也挺难得。',
];

const everydayEvening = [
  '晚饭还没吃的话，找点热乎的吧。',
  '忙了一天，回家那段路慢慢走。',
  '今天剩下的时间，想留给谁？',
  '有些话不必打字，回家说更暖和。',
  '不急着把今天讲完，留一点给明天。',
  '今晚适合坐下来，好好吃顿饭。',
  '忙完这一阵，看看家里有什么新鲜事。',
  '想放松就放松，今晚不用找理由。',
  '晚点的风要是舒服，散个步也好。',
  '今天有点累吧？早点歇着。',
  '屋里的灯亮起来，晚上就有了自己的节奏。',
  '一顿不赶时间的晚饭，听着就不错。',
];

const everydayNight = [
  '这么晚还亮着灯呀，辛苦了。',
  '夜里安静下来，脑子也该歇歇了。',
  '剩下的事，明早看可能就顺了。',
  '想法记两句就好，不用现在做完。',
  '家里静悄悄的，正适合睡个好觉。',
  '晚安，今天已经够忙了。',
  '这会儿不用和自己较劲了。',
  '希望你今晚睡得踏实。',
];

const weekdayGreetings: Record<number, string[]> = {
  0: ['周日的早上，慢一点也挺好。', '周日有空的话，和家里人吃顿不赶时间的饭。'],
  1: ['周一又来了，先从顺手的小事开始吧。', '新的一周，留点力气给喜欢的事。'],
  5: ['周五啦，晚饭想吃点什么好的？', '这一周也快过完了，周末想怎么过？'],
  6: ['周六的时间，怎么舒服怎么安排。', '周末的早饭，慢慢吃才有味道。'],
};

const lateWeekdayGreetings: Record<number, string[]> = {
  0: ['周日晚上，家里的灯看着格外暖。', '周末还剩一点，慢慢过。'],
  1: ['周一晚上了，今天过得怎么样？', '新一周才刚开始，今晚不用着急。'],
  5: ['周五晚上，终于能慢慢吃顿饭了。', '这一周够忙了，今晚放松一点。'],
  6: ['周六晚上，和家里人聊聊天也好。', '周末的夜里，发会儿呆也挺好。'],
};

const weatherGreetings = {
  clear: {
    day: ['今天的太阳看着挺舒服。', '天晴了，窗边也亮堂起来。', '这么好的天，出去走两步也挺好。'],
    late: ['夜里天色不错，抬头看看吧。', '天气晴朗，今晚散散步挺舒服。', '晴了一整天，晚上也清清爽爽。'],
  },
  cloudy: {
    day: ['今天云多，光倒是柔和。', '太阳躲在云后面，外头应该不晃眼。', '阴天喝点热的，感觉刚刚好。'],
    late: ['云多的夜里，街灯看着更亮了。', '天有点阴，回家的路上慢慢走。', '今晚云厚，家里的灯显得更暖。'],
  },
  rain: {
    day: ['附近可能有雨，伞在手边吗？', '可能要下雨，路上慢点走。', '雨天的那杯热饮，想想就舒服。'],
    late: ['外头可能有雨，回家的路慢慢走。', '预报有雨，伞带着就安心。', '雨落下来，屋里的灯更暖了。'],
  },
  snow: {
    day: ['附近可能飘雪，窗外应该很好看。', '预报有雪，路上慢点走。', '要是下雪了，记得叫家里人一起看。'],
    late: ['夜里可能有雪，回家路上慢一点。', '预报有雪，屋里暖和就很好。', '外头可能飘雪，今晚的灯格外暖。'],
  },
  hot: {
    day: ['天有点热，凉水喝着最痛快。', '外头挺热，树荫底下会舒服些。', '热天的西瓜，光想想就甜。'],
    late: ['天还热着，回家喝口凉水吧。', '热了一天，晚上的风总算舒服些。', '天气热，晚饭吃点清爽的也不错。'],
  },
  cold: {
    day: ['外头有点冷，热茶正合适。', '天冷了，家里那件厚外套该出场了。', '冷天喝一口热的，整个人都舒坦。'],
    late: ['夜里有点冷，回家路上裹紧衣服。', '外头冷，屋里有盏灯就暖和。', '天冷的晚上，热饭格外香。'],
  },
};

type TimedGreetings = { day: string[]; late: string[] };

const festivalGreetings: Array<[RegExp, TimedGreetings]> = [
  [/春节/, { day: ['春节快乐，家里今天一定挺热闹。', '过年最香的，还是那顿大家一起吃的饭。', '春节这几天，听听家里人的闲聊就很有意思。'], late: ['春节的夜里，家里的灯还亮着吗？', '新春的晚上，围着桌子聊几句就很好。', '年夜里的饺子，吃上几口才算过节。'] }],
  [/元宵/, { day: ['元宵快乐，汤圆想吃什么馅儿的？', '今天的汤圆，和喜欢的人分一碗吧。', '元宵这天，街上的灯应该很好看。'], late: ['元宵的晚上，灯亮起来就有节味了。', '一碗热汤圆，元宵夜就圆满了。', '元宵夜，和家里人坐一会儿吧。'] }],
  [/清明/, { day: ['清明了，想念的人也在心里。', '清明的春风，吹过来有点凉。', '今天要是出门，路上的春色值得看一看。'], late: ['清明的夜里，想起谁就静静想一会儿。', '清明夜，家里安静一点也好。', '清明这天过去了，愿你心里慢慢安稳。'] }],
  [/劳动/, { day: ['劳动节快乐，今天的时间可以慢一点。', '劳动节的早饭，不赶时间最好吃。', '放假这天，睡到自然醒就很幸福。'], late: ['劳动节的晚上，吃顿喜欢的饭吧。', '今天不用赶进度，和家里人坐坐。', '劳动节的夜里，放松一下也挺好。'] }],
  [/端午/, { day: ['端午安康，家里粽子是什么馅儿？', '端午的粽香一出来，就知道节到了。', '甜粽咸粽都好，和家里人一起吃最好。'], late: ['端午的晚上，还有粽子留给你吗？', '粽香还在，端午夜也有了点家的味道。', '端午安康，今晚慢慢吃顿饭。'] }],
  [/中秋/, { day: ['中秋快乐，今天的月饼分给谁？', '中秋这天，哪怕只是坐在一起也很好。', '月亮还没出来，团圆的味道已经到了。'], late: ['中秋的月亮，想和谁一起看？', '中秋夜，和家人坐在一起聊两句吧。', '月饼剩半块也好，团圆不讲究排场。'] }],
  [/国庆/, { day: ['国庆快乐，今天家里打算怎么过？', '国庆这几天，出门热闹，在家清静，都挺好。', '假期的早饭，慢慢吃才有味道。', '国庆这天，能和家里人坐下来吃顿饭就很好。'], late: ['国庆的晚上，今天玩得怎么样？', '假期里的晚饭，能吃得慢一点。', '国庆夜，街上的灯应该还挺热闹。', '家里人都在的话，国庆的晚上就很踏实。'] }],
  [/元旦/, { day: ['新年快乐，今天想吃点什么好的？', '新的一年，家里平平安安就很好。', '元旦的早晨，慢慢醒过来也挺好。'], late: ['元旦晚上，今天过得还开心吗？', '新年的夜里，家里的灯看着格外暖。', '一年刚开头，今晚慢慢过就好。'] }],
];

function timeGreetings(hour: number): string[] {
  if (hour < 6 || hour >= 22) return ['这么晚了，还没睡呀。', '夜里静下来，很多事也没那么着急。', '灵感记两句就好，明早再看。', '晚安，希望你一觉睡到天亮。'];
  if (hour < 11) return ['早上好，今天醒得早吗？', '早饭吃了没？', '新的一天，先看看窗外什么天气。', '早晨这段安静的时间，挺舒服。'];
  if (hour < 14) return ['中午啦，今天吃什么？', '午饭要是热乎的，下午心情也好些。', '饭点到了，手边的事可以等一等。', '中午歇一会儿，和家里人聊两句也好。'];
  if (hour < 19) return ['下午这会儿，窗外的光刚刚好。', '坐久了，起来走两步挺舒服。', '下午有点犯困？喝口水缓一缓。', '今天剩下的时间，慢慢来。'];
  return ['晚上好，晚饭吃了没？', '回家的路上，有没有好看的晚霞？', '今天够忙了，晚上松一口气。', '家里的灯亮着，心也会安定些。'];
}

function isLate(hour: number): boolean { return hour < 6 || hour >= 19; }
function isNight(hour: number): boolean { return hour < 6 || hour >= 22; }

function weatherKind(now: Date, weather: ChinaDayData['weather']): keyof typeof weatherGreetings | null {
  if (!weather) return null;
  const description = now.getHours() >= 18 ? weather.forecast?.nightText : weather.forecast?.dayText;
  if (description?.includes('雪')) return 'snow';
  if ((typeof weather.precipitationMm === 'number' && weather.precipitationMm > 0) || /雨|雷/.test(description ?? '')) return 'rain';
  if (typeof weather.temperatureC === 'number' && weather.temperatureC >= 32) return 'hot';
  if (typeof weather.temperatureC === 'number' && weather.temperatureC <= 3) return 'cold';
  if (description?.includes('晴')) return 'clear';
  if (/云|阴|雾/.test(description ?? '')) return 'cloudy';
  return null;
}

function weatherPool(now: Date, weather: ChinaDayData['weather']): string[] {
  const kind = weatherKind(now, weather);
  return kind ? weatherGreetings[kind][isLate(now.getHours()) ? 'late' : 'day'] : [];
}

function contextWeatherLine(label: string, kind: keyof typeof weatherGreetings | null, late: boolean): string[] {
  if (!kind) return [];
  const detail: Record<keyof typeof weatherGreetings, string> = {
    clear: late ? '天气晴朗，回家路上看看天色吧。' : '天色不错，和喜欢的人出去走走吧。',
    cloudy: late ? '云多一点，今晚早点回家吧。' : '云多一点，脚步也可以慢一点。',
    rain: late ? '可能有雨，回家路上慢一点。' : '可能有雨，出门记得带伞。',
    snow: late ? '可能飘雪，回家路上注意安全。' : '可能飘雪，出门记得添衣。',
    hot: late ? '天还热着，回家先喝口水。' : '天气热，给自己和家里人都倒杯水。',
    cold: late ? '夜里有点冷，回家记得穿暖和。' : '天气冷，出门记得多穿一件。',
  };
  return [`${label}${detail[kind]}`];
}

function dayPool(now: Date, day: ChinaDayData | null): string[] {
  if (!day?.calendar) return [];
  const { calendar } = day;
  const late = isLate(now.getHours());
  const night = isNight(now.getHours());
  const kind = weatherKind(now, day.weather);
  const festival = [...calendar.solarFestivals, ...calendar.lunarFestivals][0];
  if (festival) {
    const matching = festivalGreetings.find(([pattern]) => pattern.test(festival));
    const lines = matching?.[1][late ? 'late' : 'day'] ?? (late
      ? [`${festival}的晚上，街上应该还有点热闹。`, `${festival}这天过得怎么样？`, `${festival}的夜里，和家里人坐一会儿也好。`]
      : [`今天是${festival}，家里有什么安排？`, `${festival}这天，日子好像也有点不一样。`, `${festival}到了，找点喜欢的东西吃吧。`]);
    return [...lines, ...contextWeatherLine(`${festival}这天`, kind, late)];
  }
  if (calendar.holidayArrangement?.isOffDay === false) {
    const lines = night
      ? ['调休这一天总算过去了。', '调休到这么晚，辛苦了。', '调休的夜里，家里应该已经安静了。']
      : late
      ? ['调休这一天，晚饭想吃点什么？', '调休上班也告一段落了，回家慢慢走。', '调休的晚上，家里人等你吃饭吗？', '调休归调休，热乎的晚饭还是要有。']
      : ['调休上班的早晨，街上大概比平时安静。', '调休这天，午饭想吃点好的。', '调休上班辛苦啦，喝口水歇一歇。', '调休的日子，也可以有点自己的小乐趣。'];
    return [...lines, ...contextWeatherLine('调休这天', kind, late)];
  }
  if (calendar.holidayArrangement?.isOffDay === true) {
    const lines = night
      ? ['假期的夜深了，家里静悄悄的。', '放假的夜里，想睡个懒觉也挺好。', '假期还长，今晚做个好梦。']
      : late
      ? ['假期的晚上，家里人都在吗？', '放假的晚饭，吃得慢一点才香。', '假期夜里，街上的灯还挺热闹。', '放假的晚上，窝在家里也舒服。']
      : ['今天是假期，想去哪儿走走？', '放假的早晨，慢慢起床也挺好。', '假期里，有空和家里人吃顿不赶时间的饭。', '今天休息，发会儿呆也很合理。'];
    return [...lines, ...contextWeatherLine('假期里', kind, late)];
  }
  if (calendar.solarTerm) {
    const term = calendar.solarTerm;
    const lines = late
      ? [`${term}的晚上，天气和前些天不太一样了。`, `${term}到了，家里的夜也有了新味道。`, `${term}这天，和家里人聊聊季节的变化也好。`]
      : [`今天是${term}，外头的风有变化吗？`, `${term}到了，日子又往前走了一小截。`, `${term}这天，找个空看看窗外吧。`];
    return [...lines, ...contextWeatherLine(`${term}这天`, kind, late)];
  }
  return [];
}

export function chooseWorkspaceGreeting(now: Date, previous: string | readonly string[] | null, random: () => number = Math.random, day: ChinaDayData | null = null, selection: 'contextual' | 'varied' = 'contextual'): string {
  const hour = now.getHours();
  const contextual = dayPool(now, day);
  const weekdays = isNight(hour) ? null : isLate(hour) ? lateWeekdayGreetings : weekdayGreetings;
  const everyday = isNight(hour) ? everydayNight : isLate(hour) ? everydayEvening : everydayDay;
  const general = [...weatherPool(now, day?.weather ?? null), ...(weekdays?.[now.getDay()] ?? []), ...timeGreetings(hour), ...everyday];
  const pool = [...new Set(selection === 'varied' ? [...contextual, ...general] : contextual.length > 0 ? contextual : general)];
  const history = typeof previous === 'string' ? [previous] : previous ?? [];
  const excluded = new Set(history);
  const available = pool.filter((greeting) => !excluded.has(greeting));
  const choices = available.length > 0 ? available : pool.filter((greeting) => greeting !== history[history.length - 1]);
  const index = Math.min(Math.floor(random() * choices.length), choices.length - 1);
  return choices[Math.max(0, index)];
}

export function readCachedChinaDay(storage: Pick<Storage, 'getItem'>, now: number, date: string): ChinaDayData | null {
  try {
    const raw = storage.getItem(CHINA_DAY_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as { at?: number; day?: ChinaDayData };
    if (cached.day?.date !== date || typeof cached.at !== 'number' || now - cached.at < 0 || now - cached.at >= CHINA_DAY_CACHE_MS) return null;
    if (!('location' in cached.day)) return null;
    if (!Array.isArray(cached.day.calendar?.solarFestivals) || !Array.isArray(cached.day.calendar?.lunarFestivals)) return null;
    return cached.day;
  } catch { return null; }
}

export function saveCachedChinaDay(storage: Pick<Storage, 'setItem'>, day: ChinaDayData, now: number): void {
  const view = { date: day.date, location: day.location, calendar: day.calendar, weather: day.weather };
  try { storage.setItem(CHINA_DAY_CACHE_KEY, JSON.stringify({ at: now, day: view })); }
  catch { /* Storage can be disabled. */ }
}
