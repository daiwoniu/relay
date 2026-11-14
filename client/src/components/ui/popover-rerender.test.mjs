import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./Popover.tsx', import.meta.url), 'utf8');

test('Popover 父组件重渲染时不因 onClose 引用变化重建 overlay', () => {
  assert.match(source, /const onCloseRef = useRef\(onClose\);/);
  assert.match(source, /const requestClose = useCallback\(\(\) => onCloseRef\.current\(\), \[\]\);/);

  const overlayEffectDependencies = source.match(
    /\}, \[(closeOverlay, mobile, mobileSheet,[^\]]+)\]\);/,
  )?.[1];
  assert.ok(overlayEffectDependencies, '应能定位 Popover overlay 监听副作用依赖');
  assert.doesNotMatch(overlayEffectDependencies, /\bonClose\b/);
  assert.match(overlayEffectDependencies, /\brequestClose\b/);
  assert.match(source, /registerOverlayCloser\('popover', overlayId, requestClose\)/);
});
