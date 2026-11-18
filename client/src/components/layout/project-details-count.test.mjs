import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import { formatResourcePerson } from '../../utils/resource-person.ts';

const compiled = ts.transpileModule(fs.readFileSync(new URL('./ProjectDetailsContent.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(t) {
  const slots = [], effects = [], requests = [];
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { value: initial };
      return [slots[i].value, value => { slots[i].value = value; }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(effect, deps) {
      const i = cursor++, prior = slots[i];
      if (!prior || deps.some((v, n) => v !== prior.deps[n])) {
        slots[i] = { deps, cleanup: prior?.cleanup };
        effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = effect(); });
      }
    },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return jsx;
    if (name === '../../utils/resource-person') return { formatResourcePerson };
    if (name === '../../api/projects') return { getProject(id, signal) {
      return new Promise((resolve, reject) => requests.push({ id, signal, resolve, reject }));
    } };
    return { default: () => null };
  }, module, module.exports);
  t.after(() => { for (const slot of slots) slot?.cleanup?.(); });
  return {
    requests,
    render(id) { cursor = 0; return module.exports.default({ project: { id, name: id, path: 'D:/test' } }); },
    flush() { for (const effect of effects.splice(0)) effect(); },
  };
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree && typeof tree === 'object') return text(tree.props?.children);
  return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '';
}

test('project details loads authoritative count, aborts obsolete requests and explains shared visibility', async t => {
  const h = harness(t);
  assert.match(text(h.render('first')), /会话数：正在读取/); h.flush();
  h.render('second'); h.flush();
  assert.equal(h.requests[0].signal.aborted, true);
  h.requests[0].resolve({ session_count: 999, access_role: 'owner' }); await settle();
  assert.match(text(h.render('second')), /会话数：正在读取/);
  h.requests[1].resolve({ session_count: 75, access_role: 'viewer' }); await settle();
  assert.match(text(h.render('second')), /会话数：75/);
  assert.match(text(h.render('second')), /仅统计你有权限查看的会话/);
  h.render('third'); h.flush();
  h.requests[2].resolve({ session_count: 0, access_role: 'owner' }); await settle();
  assert.match(text(h.render('third')), /会话数：0/);
  assert.doesNotMatch(text(h.render('third')), /仅统计你有权限查看的会话/);
});

test('failed and older server responses never fabricate a zero count', async t => {
  const h = harness(t);
  h.render('failed'); h.flush(); h.requests[0].reject(new Error('offline')); await settle();
  assert.match(text(h.render('failed')), /会话数：读取失败/);
  h.render('old'); h.flush(); h.requests[1].resolve({ access_role: 'owner' }); await settle();
  assert.match(text(h.render('old')), /会话数：—/);
});
