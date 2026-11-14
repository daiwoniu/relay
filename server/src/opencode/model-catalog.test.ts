import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOpenCodeModelCatalog } from './model-catalog.js';

const OPENCODE_SESSION_RESULT = {
  sessionId: 'ses_f55c0992affeSt0Y0xtfiR3aSw',
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'opencode/big-pickle',
      options: [
        { value: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle' },
        { value: 'opencode/mimo-v2.5-free', name: 'OpenCode Zen/MiMo V2.5 Free' },
        { value: 'xs_custom/glm-5', name: 'XS Gateway (CP)/Glm 5', description: 'x1.00 credits' },
      ],
    },
    {
      id: 'mode',
      name: 'Session Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'build',
      options: [
        { value: 'build', name: 'build' },
        { value: 'plan', name: 'plan' },
      ],
    },
  ],
};

test('OpenCode session 结果从 model configOption 映射模型目录且不支持推理强度', () => {
  const catalog = parseOpenCodeModelCatalog(OPENCODE_SESSION_RESULT, { now: () => 123 });

  assert.equal(catalog.engineId, 'opencode');
  assert.equal(catalog.fetchedAt, 123);
  assert.deepEqual(catalog.models.map((model) => [model.id, model.displayName]), [
    ['opencode/big-pickle', 'Big Pickle'],
    ['opencode/mimo-v2.5-free', 'MiMo V2.5 Free'],
    ['xs_custom/glm-5', 'Glm 5'],
  ]);
  assert.equal(catalog.models[0]?.isDefault, true);
  assert.equal(catalog.models[1]?.isDefault, false);
  assert.equal(catalog.models[2]?.description, 'x1.00 credits');
  assert.deepEqual(catalog.models[0]?.inputModalities, ['text']);
  for (const model of catalog.models) {
    assert.equal(model.reasoning.supported, false);
    assert.equal(model.reasoning.scope, 'session');
    assert.deepEqual(model.reasoning.options, []);
    assert.equal(model.reasoning.defaultOptionId, undefined);
  }
});

test('OpenCode 无 model configOption 时返回空目录且不崩溃', () => {
  const catalog = parseOpenCodeModelCatalog({ sessionId: 'ses-empty', configOptions: [
    { id: 'mode', category: 'mode', currentValue: 'build', options: [{ value: 'build', name: 'build' }] },
  ] }, { now: () => 1 });

  assert.equal(catalog.engineId, 'opencode');
  assert.deepEqual(catalog.models, []);
});
