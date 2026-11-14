import assert from 'node:assert/strict';
import test from 'node:test';
import { ENGINE_CATALOG } from './catalog.js';
import { ENGINE_DEFINITIONS, ENGINE_DEFINITION_LIST } from './definition.js';

test('内置引擎定义完整且 catalog 从定义投影', () => {
  assert.deepEqual(ENGINE_DEFINITION_LIST.map((definition) => definition.id), ['codex', 'codebuddy', 'opencode', 'zcode']);
  for (const definition of ENGINE_DEFINITION_LIST) {
    assert.match(definition.shortName, /^[A-Z]{2}$/);
    assert.ok(definition.docsUrl.startsWith('https://'));
    // ZCode 是 Electron 桌面应用,不经 npm 分发,packageName 允许为空但必须有可执行候选。
    if (definition.adapterKind === 'zcode') {
      assert.equal(definition.install.packageName, '');
      assert.ok(definition.install.executableCandidates.length > 0);
    } else {
      assert.ok(definition.install.packageName.length > 0);
    }
    assert.deepEqual(ENGINE_CATALOG[definition.id], {
      id: definition.id,
      label: definition.label,
      capabilities: definition.capabilities,
    });
  }
  assert.equal(ENGINE_DEFINITIONS.codex.adapterKind, 'codex');
  assert.equal(ENGINE_DEFINITIONS.codebuddy.acp?.loginRequired, true);
  assert.equal(ENGINE_DEFINITIONS.opencode.acp?.modelOptionKey, 'model');
  assert.equal(ENGINE_DEFINITIONS.zcode.transport, 'zcode-stdio');
  assert.equal(ENGINE_DEFINITIONS.zcode.acp, undefined);
});
