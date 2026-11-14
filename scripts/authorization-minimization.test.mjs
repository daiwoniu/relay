import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const attributes = fs.readFileSync(new URL('../.gitattributes', import.meta.url), 'utf8');
const rules = fs.readFileSync(new URL('../ai/docs/rules/worktree-and-git.md', import.meta.url), 'utf8');

test('项目通过 gitattributes 固定文本换行并保护二进制文件', () => {
  assert.match(attributes, /^\* text=auto eol=lf$/m);
  for (const extension of ['png', 'jpg', 'webp', 'wasm', 'db', 'sqlite']) {
    assert.match(attributes, new RegExp(`^\\*\\.${extension} binary$`, 'm'));
  }
});

test('Git 规则要求标准命令、统一暂存并保护用户修改', () => {
  assert.match(rules, /可使用标准命令/);
  assert.match(rules, /最终验证、清理完成后统一暂存/);
  assert.match(rules, /不为记录提交结果额外制造第二轮暂存/);
  assert.match(rules, /现有和新出现的无关修改都属于用户/);
  assert.match(rules, /禁止使用 `git reset --hard`、强制 checkout/);
  assert.match(rules, /npm run worktree:clean -- <名称>/);
});

test('共享文件跨会话修改必须由用户选择提交方式', () => {
  assert.match(rules, /暂存前先检查 `git diff --cached`/);
  assert.match(rules, /非本会话已暂存内容.*不得擅自取消暂存或直接提交/);
  assert.match(rules, /重新整理只调整 index.*保留工作区内容/);
  assert.match(rules, /无法确认时按共享修改处理/);
  assert.match(rules, /同一文件同时包含本会话和其他会话的修改.*不默认按 hunk 自动拆分/s);
  assert.match(rules, /跳过该文件并继续提交其他文件.*暂停整个提交/);
  assert.match(rules, /跳过共享文件后只有剩余提交仍完整、可验证时才能继续/);
  assert.match(rules, /只有用户选择拆分后才按 hunk 操作/);
  assert.match(rules, /完整工作区测试不能冒充暂存子集的独立验证/);
  assert.match(rules, /一起提交.*共享文件还是既有暂存内容.*不代表接管其他任务或豁免质量要求/s);
  assert.match(rules, /暂存区只包含用户已授权的范围/);
  assert.match(rules, /共享文件或既有暂存区发生变化时，原选择失效/);
});
