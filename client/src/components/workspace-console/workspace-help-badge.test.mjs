import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsxForTest } from '../ui/tsx-test-helper.mjs';
import { formatHelpText } from './workspace-help-text.ts';

const { default: WorkspaceHelpBadge } = await loadTsxForTest(new URL('./WorkspaceHelpBadge.tsx', import.meta.url).href);

test('help text splits Chinese sentences and semicolons while retaining existing lines, IDs, decimals and links',()=>{
 const format=formatHelpText;
 assert.equal(format('第一句。第二句；第三句; 第四句。'),'第一句。\n第二句；\n第三句;\n第四句。');
 assert.equal(format('第一句。\n第二句；\r\n第三句。'),'第一句。\n第二句；\r\n第三句。');
 assert.equal(format('版本 2.5，ID 7174371958：https://example.com/a.b。'), '版本 2.5，ID 7174371958：https://example.com/a.b。');
 assert.equal(format('已完成。 \n保留空行\n\n下一段'),'已完成。 \n保留空行\n\n下一段');
});

test('sentence breaks preserve quotes, existing breaks, links and values', () => {
  assert.equal(formatHelpText('怎么存？点「下载」。好了！可以发给朋友。'), '怎么存？\n点「下载」。\n好了！\n可以发给朋友。');
  assert.equal(formatHelpText('选择「保存好了！」然后关闭。'), '选择「保存好了！」\n然后关闭。');
  assert.equal(formatHelpText('链接是 https://example.com/a?x=1;y=2。版本 2.5，下午 12:30。下一句。'), '链接是 https://example.com/a?x=1;y=2。\n版本 2.5，下午 12:30。\n下一句。');
  assert.equal(formatHelpText(formatHelpText('准备好了？！ 可以继续；别忘了保存。')), '准备好了？！\n可以继续；\n别忘了保存。');
});

test('help badges delegate hover, focus and tap to a single tooltip', () => {
  const badge = WorkspaceHelpBadge({ label: '等待中', content: '辅助解释。第二条；第三条', coexist: true });
  const hint = badge.props.children;
  assert.ok(!Array.isArray(hint));
  assert.equal(hint.props.content, '辅助解释。\n第二条；\n第三条');
  assert.equal(hint.props.asChild, true);
  assert.equal(hint.props.pinOnClick, true);
  assert.equal(hint.props.coexist, true);
  assert.equal(hint.props.children.type, 'button');
  assert.equal(hint.props.children.props['aria-label'], '等待中说明');
  assert.equal(hint.props.children.props['aria-haspopup'], undefined);
});
