interface Unit { id: string; label: string; scale: number; offset?: number }
const unit = (id: string, label: string, scale: number, offset = 0): Unit => ({ id, label, scale, offset });
export const UNIT_GROUPS = {
  weight: { label: '重量', units: [unit('kg', '公斤 / 千克', 1), unit('jin', '市斤', .5), unit('g', '克', .001), unit('liang', '市两', .05), unit('t', '吨', 1000)] },
  length: { label: '长度', units: [unit('m', '米', 1), unit('cm', '厘米', .01), unit('mm', '毫米', .001), unit('km', '千米', 1000), unit('inch', '英寸', .0254)] },
  area: { label: '面积', units: [unit('m2', '平方米', 1), unit('mu', '亩', 2000 / 3), unit('ha', '公顷', 10000), unit('km2', '平方千米', 1e6), unit('cm2', '平方厘米', .0001)] },
  volume: { label: '容量', units: [unit('l', '升', 1), unit('ml', '毫升', .001), unit('m3', '立方米', 1000)] },
  temperature: { label: '温度', units: [unit('c', '摄氏度 °C', 1), unit('f', '华氏度 °F', 5 / 9, -32), unit('k', '开尔文 K', 1, -273.15)] },
} satisfies Record<string, { label: string; units: Unit[] }>;
export type UnitGroupId = keyof typeof UNIT_GROUPS;

function numberInput(raw: string, label: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim())) throw new Error(`请输入正确的${label}。`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${label}超出可计算范围。`);
  return value;
}
export function convertUnit(group: UnitGroupId, raw: string, fromId: string, toId: string): number {
  const units = UNIT_GROUPS[group].units;
  const from = units.find((value) => value.id === fromId), to = units.find((value) => value.id === toId);
  if (!from || !to) throw new Error('请选择正确的单位。');
  const value = numberInput(raw, '数值');
  const base = (value + (from.offset ?? 0)) * from.scale;
  if (group === 'temperature' ? base < -273.15 - 1e-10 : base < 0) throw new Error(group === 'temperature' ? '温度不能低于绝对零度。' : '数值不能为负数。');
  const result = base / to.scale - (to.offset ?? 0);
  if (!Number.isFinite(result)) throw new Error('结果超出可计算范围。');
  return Object.is(result, -0) ? 0 : result;
}

const DAY = 86400000;
export function calendarDay(raw: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) throw new Error('请选择完整日期。');
  const [, y, m, d] = match;
  const date = new Date(0); date.setUTCFullYear(+y, +m - 1, +d);
  if (+y < 1 || date.getUTCFullYear() !== +y || date.getUTCMonth() !== +m - 1 || date.getUTCDate() !== +d) throw new Error('日期不正确。');
  return date.getTime();
}
export function dateDifference(start: string, end: string): number { return (calendarDay(end) - calendarDay(start)) / DAY; }
export function shiftDate(start: string, raw: string): string {
  if (!/^[+-]?\d+$/.test(raw.trim())) throw new Error('天数请输入整数，可用负数表示之前。');
  const offset = Number(raw);
  if (!Number.isSafeInteger(offset) || Math.abs(offset) > 3650000) throw new Error('天数超出支持范围。');
  const date = new Date(calendarDay(start) + offset * DAY);
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) throw new Error('结果日期超出支持范围。');
  return date.toISOString().slice(0, 10);
}
export function ageAt(birth: string, end: string): { years: number; days: number } {
  const days = dateDifference(birth, end);
  if (days < 0) throw new Error('出生日期不能晚于计算日期。');
  let years = Number(end.slice(0, 4)) - Number(birth.slice(0, 4));
  if (end.slice(5) < birth.slice(5)) years--;
  return { years, days };
}

export function moneyCents(raw: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!match) throw new Error('金额请输入非负数，最多两位小数。');
  const value = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(value) || value > 1e12) throw new Error('金额超出可计算范围。');
  return value;
}
export function comparePrices(priceA: string, quantityA: string, priceB: string, quantityB: string) {
  const a = moneyCents(priceA), b = moneyCents(priceB);
  const qa = numberInput(quantityA, '数量'), qb = numberInput(quantityB, '数量');
  if (qa <= 0 || qb <= 0) throw new Error('数量或净含量必须大于零。');
  const unitA = a / 100 / qa, unitB = b / 100 / qb;
  if (!Number.isFinite(unitA) || !Number.isFinite(unitB)) throw new Error('数量过小，无法比较。');
  const equal = Math.abs(unitA - unitB) <= Math.max(unitA, unitB) * 1e-12;
  return { unitA, unitB, cheaper: equal ? 'equal' : unitA < unitB ? 'a' : 'b', savingPercent: equal ? 0 : (1 - Math.min(unitA, unitB) / Math.max(unitA, unitB)) * 100 };
}
export function discountPrice(price: string, fold: string, coupon: string) {
  const original = moneyCents(price), reduction = moneyCents(coupon);
  if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(fold.trim())) throw new Error('折扣请输入 0～10，例如 8.5 表示八五折。');
  const [whole, fraction = ''] = fold.trim().split('.');
  const foldHundredths = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (foldHundredths > 1000) throw new Error('折扣不能超过 10 折。');
  const discounted = Math.round(original * foldHundredths / 1000);
  const payable = Math.max(0, discounted - reduction);
  return { original, discounted, payable, saved: original - payable };
}
export function thresholdDeal(current: string, threshold: string, reduction: string) {
  const original = moneyCents(current), target = moneyCents(threshold), coupon = moneyCents(reduction);
  if (target === 0 || coupon > target) throw new Error('满减门槛须大于零，减免不能超过门槛。');
  const gap = Math.max(0, target - original);
  const payable = original + gap - coupon;
  return { gap, payable, extraPay: payable - original };
}

export function parseOptions(raw: string): string[] {
  if (raw.length > 50000) throw new Error('候选内容过长，请缩短后重试。');
  const result = [...new Set(raw.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
  if (!result.length) throw new Error('至少输入一个候选项。');
  if (result.length > 500) throw new Error('最多支持 500 个不同候选项。');
  return result;
}
function randomIndex(max: number): number {
  if (!globalThis.crypto?.getRandomValues) return Math.floor(Math.random() * max);
  const buffer = new Uint32Array(1), bound = Math.floor(0x100000000 / max) * max;
  do { globalThis.crypto.getRandomValues(buffer); } while (buffer[0] >= bound);
  return buffer[0] % max;
}
export function drawOptions(items: string[], count: number, index = randomIndex): string[] {
  if (!Number.isInteger(count) || count < 1 || count > items.length) throw new Error('抽取数量须在 1 和候选项数量之间。');
  const shuffled = [...items];
  for (let i = 0; i < count; i++) {
    const j = i + index(shuffled.length - i);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}
export function randomGroups(items: string[], count: number): string[][] {
  if (items.length < 2) throw new Error('随机分组至少需要两个不同候选项。');
  if (!Number.isInteger(count) || count < 2 || count > items.length) throw new Error('组数须在 2 和候选项数量之间。');
  const groups: string[][] = Array.from({ length: count }, () => []);
  drawOptions(items, items.length).forEach((value, i) => groups[i % count].push(value));
  return groups;
}
