import assert from 'node:assert/strict';
import test from 'node:test';
import { applyThemeRuntime, clearThemeRuntime } from './theme-runtime.ts';

function createRoot() {
  const values = new Map();
  return {
    dataset: {},
    style: {
      setProperty(name, value) { values.set(name, value); },
      removeProperty(name) { values.delete(name); },
      getPropertyValue(name) { return values.get(name) ?? ''; },
    },
  };
}

test('运行时清理旧作用域后原子应用完整主题维度', () => {
  const root = createRoot();
  root.dataset.colorStyle = 'old';
  root.style.setProperty('--theme-panel-opacity-input', '0.2');
  globalThis.document = {
    documentElement: root,
    querySelector() { return { setAttribute(name, value) { root.meta = { name, value }; } }; },
  };
  applyThemeRuntime('dark', {
    backgroundKind: 'none', backgroundValue: null, blur: 0, fit: 'cover', position: 'center',
    overlayColor: '#000000', overlayOpacity: 0, panelOpacity: 0.8, glassBlur: 4, borderStrength: 0.7,
  }, 'aurora', 'large', 'workspace');
  assert.deepEqual(root.dataset, {
    theme: 'dark', colorStyle: 'aurora', textScale: 'large', themeScope: 'workspace', advancedTheme: 'true',
  });
  assert.equal(root.style.getPropertyValue('--theme-panel-opacity-input'), '0.8');
  assert.deepEqual(root.meta, { name: 'content', value: '#12131d' });
  clearThemeRuntime(root);
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(root.dataset.colorStyle, undefined);
  assert.equal(root.style.getPropertyValue('--theme-panel-opacity-input'), '');
});
