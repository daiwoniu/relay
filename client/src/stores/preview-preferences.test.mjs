import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsxForTest } from '../components/ui/tsx-test-helper.mjs';
const { usePreviewPreferences, defaultPreviewPreferences } = await loadTsxForTest(new URL('./preview-preferences.ts', import.meta.url).href);
const settle = () => new Promise(resolve => setImmediate(resolve));

test('initial non-default settings advance the revision so an already opened preview is rebuilt', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ...defaultPreviewPreferences(), imagePreset: 'enhanced' }));
  usePreviewPreferences.getState().configure('slow-bootstrap');
  assert.equal(usePreviewPreferences.getState().loaded, false);
  await usePreviewPreferences.getState().load();
  assert.equal(usePreviewPreferences.getState().revision, 1);
  usePreviewPreferences.getState().configure(null);
});

test('account switches discard pending reads and saves; failures preserve last saved values', async t => {
  const pending = [];
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise(resolve => pending.push({ url, options, resolve })));
  const state = () => usePreviewPreferences.getState();
  state().configure('first', true);
  const firstRead = state().load();
  state().configure('second');
  const secondRead = state().load();
  pending[0].resolve(Response.json({ ...defaultPreviewPreferences(), capacityPreset: 'higher' }));
  await firstRead;
  assert.equal(state().loaded, false);
  pending[1].resolve(Response.json(defaultPreviewPreferences()));
  await secondRead;
  assert.equal(state().userId, 'second'); assert.equal(state().preferences.capacityPreset, 'default');
  const failure = state().save({ capacityPreset: 'enhanced' });
  pending[2].resolve(Response.json({ error: '保存失败' }, { status: 503 }));
  await failure;
  assert.equal(state().preferences.capacityPreset, 'default'); assert.equal(state().revision, 0); assert.equal(state().error, '保存失败');
  const successful = state().save({ capacityPreset: 'enhanced' });
  assert.deepEqual(JSON.parse(pending[3].options.body), { capacityPreset: 'enhanced' });
  pending[3].resolve(Response.json({ ...defaultPreviewPreferences(), capacityPreset: 'enhanced' }));
  await successful;
  assert.equal(state().revision, 1);
  const staleSave = state().save({ imagePreset: 'higher' });
  state().configure('third');
  pending[4].resolve(Response.json({ ...defaultPreviewPreferences(), imagePreset: 'higher' }));
  await staleSave; await settle();
  assert.equal(state().preferences.imagePreset, 'default'); assert.equal(state().loaded, false); assert.equal(state().saving, false);
  state().configure(null);
});
