import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as greeting from '../components/workspace-console/workspace-greeting.ts';

const complete = { date: '2026-11-17', location: { city: '济宁' },
  calendar: { solarFestivals: [], lunarFestivals: [], solarTerm: null, holidayArrangement: null },
  weather: { temperatureC: 10, precipitationMm: 0, forecast: null } };
const source = ts.transpileModule(fs.readFileSync(new URL('./useChinaDayGreeting.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

// Execute the actual hook with deterministic state/effect scheduling and its real cache helpers.
// This checks hook recovery and cancellation, not browser rendering.
function harness({ initial, fetchDay }) {
  let at = Date.parse('2026-11-17T12:00:00Z'), cursor = 0, dirty = true, view;
  const slots = [], pending = [], timers = new Set(), values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  if (initial) greeting.saveCachedChinaDay(storage, initial, at);
  class TaskDate extends Date {
    constructor(...args) { super(...(args.length ? args : [at])); }
    static now() { return at; }
  }
  const react = {
    useState(init) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof init === 'function' ? init() : init;
      return [slots[index], next => {
        const value = typeof next === 'function' ? next(slots[index]) : next;
        if (!Object.is(value, slots[index])) { slots[index] = value; dirty = true; }
      }];
    },
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    useEffect(effect, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        previous?.cleanup?.();
        slots[index] = { deps };
        pending.push(() => { slots[index].cleanup = effect(); });
      }
    },
  };
  const exports = {};
  vm.runInNewContext(source, { exports, Date: TaskDate, AbortController,
    window: { sessionStorage: storage, localStorage: storage,
      setInterval: callback => { timers.add(callback); return callback; }, clearInterval: callback => timers.delete(callback) },
    require: name => {
      if (name === 'react') return react;
      if (name === '../api/china-day') return { getChinaDay: fetchDay };
      if (name.includes('workspace-greeting')) return greeting;
      throw new Error(`Unexpected import ${name}`);
    },
  });
  const render = () => {
    while (dirty) { dirty = false; cursor = 0; view = exports.useChinaDayGreeting(); while (pending.length) pending.shift()(); }
  };
  render();
  return {
    get view() { return view; },
    async settle() { await new Promise(resolve => setImmediate(resolve)); render(); },
    async minute() { at += 60_000; for (const callback of timers) callback(); render(); await this.settle(); },
    close() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test('calendar-only cached data revalidates on mount and restores missing weather', async (t) => {
  let calls = 0;
  const hook = harness({ initial: { ...complete, weather: null }, fetchDay: async () => { calls++; return complete; } });
  t.after(() => hook.close());
  await hook.settle();
  assert.equal(calls, 1);
  assert.equal(hook.view.day.weather.temperatureC, 10);
});

test('failed weather retries while mounted and stops retrying after recovery', async (t) => {
  let calls = 0;
  const hook = harness({ fetchDay: async () => ++calls === 1 ? { ...complete, weather: null } : complete });
  t.after(() => hook.close());
  await hook.settle();
  assert.equal(hook.view.day.weather, null);
  await hook.minute();
  assert.equal(hook.view.day.weather.temperatureC, 10);
  await hook.minute();
  assert.equal(calls, 2);
});

test('successful cache expires after ten minutes without leaving the page', async (t) => {
  let calls = 0;
  const hook = harness({ initial: complete, fetchDay: async () => { calls++; return complete; } });
  t.after(() => hook.close());
  for (let i = 0; i < 9; i++) await hook.minute();
  assert.equal(calls, 0);
  await hook.minute();
  assert.equal(calls, 1);
});

test('HTTP rejection retries and unmount aborts and ignores late results', async () => {
  let calls = 0, signal, resolve;
  const hook = harness({ fetchDay: async currentSignal => {
    calls++; signal = currentSignal;
    if (calls === 1) throw new Error('temporarily unavailable');
    return new Promise(done => { resolve = done; });
  } });
  await hook.settle();
  await hook.minute();
  assert.equal(calls, 2);
  hook.close();
  assert.equal(signal.aborted, true);
  resolve(complete);
  await hook.settle();
  assert.equal(hook.view.day, null);
});
