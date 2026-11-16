import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';

const source = fs.readFileSync(new URL('./ProjectMembersDialog.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;

function harness(api) {
  const slots = [];
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = value; }];
    },
    useEffect() {},
    useMemo: fn => fn(),
  };
  const module = { exports: {} };
  function FailureNotice() {}
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return jsx;
    if (name === '../../api/projects') return api;
    if (name === '../ui/FailureNotice') return { default: FailureNotice };
    return { default: () => null, ClosePanelIcon: () => null };
  }, module, module.exports);
  const render = () => {
    cursor = 0;
    return module.exports.default({ project: { id: 'project', name: '项目' }, onClose() {} });
  };
  function nodes(tree, predicate) {
    if (!tree || typeof tree !== 'object') return [];
    if (Array.isArray(tree)) return tree.flatMap(node => nodes(node, predicate));
    return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
  }
  return {
    render,
    find: (tree, predicate) => nodes(tree, predicate)[0],
    notice: tree => nodes(tree, node => node.type === FailureNotice)[0],
    seedMembers() { slots[0] = [{ user_id: 'member', role: 'collaborator', can_view_sessions: 0 }]; },
  };
}

test('添加授权保留接口异常对象与错误码，失败后允许重新操作', async () => {
  const error = Object.assign(new Error('请求来源不受允许'), { status: 403, data: { code: 'PROJECT_MEMBER_ORIGIN_FORBIDDEN' } });
  const h = harness({ setProjectMember: async () => { throw error; } });
  h.find(h.render(), node => node.type === 'select' && node.props.value === '').props.onChange({ target: { value: 'member' } });
  await h.find(h.render(), node => node.type === 'button' && node.props.children === '添加').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  const tree = h.render();
  assert.equal(h.notice(tree).props.error, error);
  assert.equal(h.find(tree, node => node.type === 'button' && node.props.children === '添加').props.disabled, false);
});

for (const action of ['role', 'visibility', 'remove']) test(`${action} 失败保留真实异常`, async () => {
  const error = new Error('存储暂不可用');
  const fail = async () => { throw error; };
  const h = harness({ setProjectMember: fail, removeProjectMember: fail });
  h.render(); h.seedMembers();
  const tree = h.render();
  if (action === 'role') await h.find(tree, node => node.type === 'select' && node.props.value === 'collaborator').props.onChange({ target: { value: 'viewer' } });
  if (action === 'visibility') await h.find(tree, node => node.type === 'input' && 'checked' in node.props).props.onChange({ target: { checked: true } });
  if (action === 'remove') await h.find(tree, node => node.type === 'button' && node.props.children === '移除').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.notice(h.render()).props.error, error);
});

test('写入成功但刷新失败明确区分已完成操作，保留刷新原始异常', async () => {
  const error = new Error('刷新连接失败');
  let writes = 0;
  const h = harness({ setProjectMember: async () => { writes++; }, listProjectMembers: async () => { throw error; } });
  h.find(h.render(), node => node.type === 'select' && node.props.value === '').props.onChange({ target: { value: 'member' } });
  await h.find(h.render(), node => node.type === 'button' && node.props.children === '添加').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  const tree = h.render();
  assert.equal(writes, 1);
  assert.equal(h.notice(tree).props.error, error);
  assert.ok(h.find(tree, node => node.type === 'span' && /操作已完成/.test(node.props.children)));
});
