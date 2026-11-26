import { useState } from 'react';
import type { LifeToolId } from './tools-state';
import { UNIT_GROUPS, ageAt, collectOptions, comparePrices, convertUnit, dateDifference, discountPrice, drawOptions, parseOptions, randomGroups, shiftDate, thresholdDeal, type UnitGroupId } from './life-tools-model';
import { ToolError, ToolModes, ToolResult, toolButton, toolInput, toolPrimary } from './tool-ui';
import {tracker} from '../../analytics/tracker';
import { trackToolAction } from '../../analytics/tracker';

const numberText = (value: number) => new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 12 }).format(value);
const yuan = (cents: number) => `${(cents / 100).toFixed(2)} 元`;
const errorText = (error: unknown) => error instanceof Error ? error.message : '请检查输入后重试。';
function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export default function LifeTools({ id }: { id: LifeToolId }) {
  if (id === 'units') return <UnitTool />;
  if (id === 'dates') return <DateTool />;
  if (id === 'shopping') return <ShoppingTool />;
  return <RandomTool />;
}

function UnitTool() {
  const [group, setGroup] = useState<UnitGroupId>('weight');
  const [value, setValue] = useState('1');
  const [from, setFrom] = useState('kg'), [to, setTo] = useState('jin');
  const units = UNIT_GROUPS[group].units;
  let result = '', error = '';
  if (value.trim()) {
    try { result = `${numberText(convertUnit(group, value, from, to))} ${units.find((unit) => unit.id === to)?.label}`; }
    catch (reason) { error = errorText(reason); }
  }
  return <div className="space-y-4">
    <label className="block space-y-2 text-sm"><span>要换算什么</span><select className={toolInput} value={group} onChange={(event) => {
      const next = event.target.value as UnitGroupId;
      if (next === group) return;
      tracker.action({ feature: 'tools', action: 'configure', surface: 'tools', toolId: 'units' });
      setGroup(next); setFrom(UNIT_GROUPS[next].units[0].id); setTo(UNIT_GROUPS[next].units[1].id);
    }}>{Object.entries(UNIT_GROUPS).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}</select></label>
    <div className="grid items-end gap-3 grid-cols-2">
      <label className="space-y-2 text-sm"><span>要换算的数字</span><input className={toolInput} value={value} inputMode={group === 'temperature' ? 'text' : 'decimal'} onChange={(event) => setValue(event.target.value)} enterKeyHint="done" /></label>
      <label className="space-y-2 text-sm"><span>原来是什么单位</span><select className={toolInput} value={from} onChange={(event) => {tracker.action({feature:'tools',action:'configure',surface:'tools',toolId:'units'});setFrom(event.target.value);}}>{units.map((unit) => <option key={unit.id} value={unit.id}>{unit.label}</option>)}</select></label>
    </div>
    <div className="grid items-end gap-3 grid-cols-2">
      <button type="button" className={toolButton} onClick={() => { tracker.action({feature:'tools',action:'configure',surface:'tools',toolId:'units'}); setFrom(to); setTo(from); }}>交换单位 ⇅</button>
      <label className="space-y-2 text-sm"><span>换成什么单位</span><select className={toolInput} value={to} onChange={(event) => {tracker.action({feature:'tools',action:'configure',surface:'tools',toolId:'units'});setTo(event.target.value);}}>{units.map((unit) => <option key={unit.id} value={unit.id}>{unit.label}</option>)}</select></label>
    </div><ToolError message={error} />
    {result && <ToolResult text={result} title={result} />}
  </div>;
}

function DateTool() {
  const [mode, setMode] = useState<'difference' | 'shift' | 'age'>('difference');
  const [base, setBase] = useState(localToday), [end, setEnd] = useState(localToday);
  const [birth, setBirth] = useState('');
  const start = mode === 'age' ? birth : base;
  const [days, setDays] = useState('30');
  const [result, setResult] = useState(''), [error, setError] = useState('');
  const clear = () => { setResult(''); setError(''); };
  function calculate() {
    try {
      if (mode === 'difference') {
        const count = dateDifference(start, end);
        setResult(count === 0 ? '两个日期是同一天。' : `目标日期在起始日期的 ${Math.abs(count)} 天${count > 0 ? '后' : '前'}。`);
      } else if (mode === 'shift') setResult(`计算结果：${shiftDate(start, days)}`);
      else {
        const age = ageAt(start, end); setResult(`${age.years} 周岁，已度过 ${age.days.toLocaleString('zh-CN')} 天。`);
      }
      setError('');trackToolAction('dates','calculate');
    } catch (reason) { setResult(''); setError(errorText(reason));trackToolAction('dates','calculate','invalid_input'); }
  }
  return <div className="space-y-4">
    <ToolModes label="日期计算方式" options={[[ 'difference', '日期间隔' ], [ 'shift', '日期加减' ], [ 'age', '周岁' ]]} value={mode}
      onChange={next => { tracker.action({ feature: 'tools', action: 'mode', surface: 'tools', toolId: 'dates', mode: next }); setMode(next); clear(); }} />
    <div className="grid gap-4 sm:grid-cols-2"><label className="min-w-0 space-y-2 text-sm"><span>{mode === 'age' ? '出生日期' : '起始日期'}</span><input type="date" min="0001-01-01" max="9999-12-31" className={toolInput} value={start} onChange={(event) => { (mode === 'age' ? setBirth : setBase)(event.target.value); clear(); }} /></label>
      {mode === 'shift' ? <label className="space-y-2 text-sm"><span>加减天数（负数表示之前）</span><input className={toolInput} value={days} onChange={(event) => { setDays(event.target.value); clear(); }} placeholder="例如 30 或 -7"  enterKeyHint="done" /></label>
        : <label className="min-w-0 space-y-2 text-sm"><span>{mode === 'age' ? '计算日期' : '目标日期'}</span><input type="date" min="0001-01-01" max="9999-12-31" className={toolInput} value={end} onChange={(event) => { setEnd(event.target.value); clear(); }} /></label>}
    </div>
    <button type="button" className={toolPrimary} onClick={calculate}>计算</button><ToolError message={error} />
    {result && <ToolResult title={result} text={result}><p className="text-sm text-[var(--tools-quiet)]">
      {mode === 'age' ? '按生日计算周岁。2 月 29 日出生的人，平年按 3 月 1 日算。'
        : mode === 'shift' ? '从起始日期加减日历天数。' : '按日期之差计算。周一到周三相隔 2 天。'}
    </p></ToolResult>}
  </div>;
}

function ShoppingTool() {
  const [mode, setMode] = useState<'compare' | 'discount' | 'threshold'>('compare');
  const [values, setValues] = useState({ a: '', qa: '', b: '', qb: '', price: '', fold: '8.5', coupon: '0', current: '', threshold: '', reduction: '' });
  const [result, setResult] = useState(''), [error, setError] = useState('');
  function field(id: keyof typeof values, label: string, placeholder = '') {
    return <label className="space-y-2 text-sm"><span>{label}</span><input className={toolInput} inputMode="decimal" value={values[id]} placeholder={placeholder} maxLength={20} onChange={(event) => { setValues((state) => ({ ...state, [id]: event.target.value })); setResult(''); setError(''); }}  enterKeyHint="done" /></label>;
  }
  function calculate() {
    try {
      if (mode === 'compare') {
        const value = comparePrices(values.a, values.qa, values.b, values.qb);
        setResult(`${value.cheaper === 'equal' ? '两件商品单价相同' : `商品 ${value.cheaper.toUpperCase()} 每单位便宜约 ${numberText(value.savingPercent)}%`}\n商品 A：每单位 ${numberText(value.unitA)} 元\n商品 B：每单位 ${numberText(value.unitB)} 元`);
      } else if (mode === 'discount') {
        const value = discountPrice(values.price, values.fold, values.coupon);
        setResult(`实付 ${yuan(value.payable)}\n折后：${yuan(value.discounted)}\n共节省：${yuan(value.saved)}`);
      } else {
        const value = thresholdDeal(values.current, values.threshold, values.reduction);
        setResult(`${value.gap === 0 ? '已达到满减门槛。' : `还需凑单：${yuan(value.gap)}`}\n优惠后实付：${yuan(value.payable)}${value.gap === 0 ? '' : `\n与当前未优惠金额相比${value.extraPay < 0 ? '少付' : '多付'}：${yuan(Math.abs(value.extraPay))}`}`);
      }
      setError('');trackToolAction('shopping','calculate');
    } catch (reason) { setResult(''); setError(errorText(reason));trackToolAction('shopping','calculate','invalid_input'); }
  }
  return <div className="space-y-4">
    <ToolModes label="购物计算方式" options={[[ 'compare', '比价' ], [ 'discount', '折扣与券' ], [ 'threshold', '满减凑单' ]]} value={mode}
      onChange={next => { tracker.action({ feature: 'tools', action: 'mode', surface: 'tools', toolId: 'shopping', mode: next }); setMode(next); setResult(''); setError(''); }} />
    {mode === 'compare' ? <><p className="text-sm text-[var(--tools-quiet)]">两件商品的数量请用同一种单位，例如都填克。</p><div className="grid gap-3 sm:grid-cols-2">
      <fieldset className="tool-product grid gap-3"><legend>商品 A</legend>{field('a', '价格（元）')}{field('qa', '数量或净含量')}</fieldset>
      <fieldset className="tool-product grid gap-3"><legend>商品 B</legend>{field('b', '价格（元）')}{field('qb', '数量或净含量')}</fieldset>
    </div></>
      : mode === 'discount' ? <div className="grid gap-4 sm:grid-cols-3">{field('price', '原价（元）')}{field('fold', '折扣（折）', '8.5 表示八五折')}{field('coupon', '折后再减券（元）')}</div>
        : <div className="grid gap-4 sm:grid-cols-3">{field('current', '当前商品金额（元）')}{field('threshold', '满多少元')}{field('reduction', '减多少元')}</div>}
    <button type="button" className={toolPrimary} onClick={calculate}>计算</button><ToolError message={error} />
    {result && <ToolResult title={result.split('\n')[0]} text={result}><ul className="mt-2 space-y-1">{result.split('\n').slice(1).map(line => <li key={line}>{line}</li>)}</ul></ToolResult>}
  </div>;
}

function RandomTool() {
  const [mode, setMode] = useState<'draw' | 'groups'>('draw');
  const [input, setInput] = useState('火锅\n面条\n家常菜\n饺子');
  const [counts, setCounts] = useState({ draw: '1', groups: '2' });
  const count = counts[mode];
  const [result, setResult] = useState<string[][] | null>(null), [error, setError] = useState('');
  function run() {
    try {
      if (!/^\d+$/.test(count)) throw new Error('请输入整数数量。');
      const options = parseOptions(input), amount = Number(count);
      setResult(mode === 'draw' ? [drawOptions(options, amount)] : randomGroups(options, amount)); setError('');trackToolAction('random','randomize');
    } catch (reason) { setResult(null); setError(errorText(reason));trackToolAction('random','randomize','invalid_input'); }
  }
  const { options, duplicates } = collectOptions(input);
  const text = result?.map((group, i) => `${mode === 'groups' ? `第 ${i + 1} 组：\n` : ''}${group.join('\n')}`).join('\n\n') ?? '';
  return <div className="space-y-4">
    <ToolModes label="随机方式" options={[[ 'draw', '抽取选项' ], [ 'groups', '随机分组' ]]} value={mode}
      onChange={next => { tracker.action({ feature: 'tools', action: 'mode', surface: 'tools', toolId: 'random', mode: next }); setMode(next); setResult(null); setError(''); }} />
    <label className="block space-y-2 text-sm"><span>写下名字或选项（一行一个，重复只算一次）</span><textarea className={`${toolInput} min-h-40`} maxLength={50000} value={input} onChange={(event) => { setInput(event.target.value); setResult(null); setError(''); }} enterKeyHint="done" /></label>
    <p className="text-sm text-[var(--tools-quiet)]">{options.length} 个有效选项 · 已合并 {duplicates} 个重复项</p>
    <label className="block space-y-2 text-sm"><span>{mode === 'draw' ? '抽取几个（不重复）' : '分成几组（人数尽量均匀）'}</span><input className={toolInput} inputMode="numeric" value={count} onChange={(event) => { setCounts({ ...counts, [mode]: event.target.value }); setResult(null); setError(''); }} enterKeyHint="done" /></label>
    <button type="button" className={toolPrimary} onClick={run}>{result ? '重新随机一次' : mode === 'draw' ? '帮我选' : '开始分组'}</button><ToolError message={error} />
    {result && <ToolResult title={mode === 'groups' ? `已分成 ${result.length} 组` : `抽中 ${result[0].length} 项`} text={text}>
      <div className="grid max-h-96 gap-3 overflow-y-auto sm:grid-cols-2">{result.map((group, i) => <div key={i} className="tool-product">{mode === 'groups' && <h3 className="mb-2 text-sm font-semibold">第 {i + 1} 组 · {group.length} 人 / 项</h3>}<ul className="space-y-2 text-lg">{group.map((item) => <li key={item}>{item}</li>)}</ul></div>)}</div>
    </ToolResult>}
  </div>;
}
