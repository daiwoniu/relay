import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveComposerModelPreferences } from './composer-model-preferences.ts';

const user={defaultEngine:'codex',defaultModelId:'sol',defaultReasoningEffort:'medium',defaultServiceTier:'ultrafast'};
test('新会话继承同引擎账号默认，已有会话及明确草稿优先且保留null',()=>{
  assert.deepEqual(resolveComposerModelPreferences('codex',user),{modelId:'sol',reasoningEffort:'medium',serviceTier:'ultrafast'});
  const follow={modelId:null,reasoningEffort:null,serviceTier:null};
  assert.equal(resolveComposerModelPreferences('codex',user,follow),follow);
  assert.equal(resolveComposerModelPreferences('codex',user,undefined,follow),follow);
  assert.deepEqual(resolveComposerModelPreferences('codebuddy',user),follow);
  assert.deepEqual(resolveComposerModelPreferences('codex',null),follow);
  assert.deepEqual(resolveComposerModelPreferences('codex',{defaultEngine:'codex',defaultModelId:'old'}),{modelId:'old',reasoningEffort:null,serviceTier:null});
});
