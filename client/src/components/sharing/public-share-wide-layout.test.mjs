import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const pageSource = fs.readFileSync(new URL('./PublicSharePage.tsx', import.meta.url), 'utf8');
const messageListSource = fs.readFileSync(new URL('./PublicShareMessageList.tsx', import.meta.url), 'utf8');

test('公开分享页提供仅在桌面显示的宽屏切换按钮', () => {
  assert.match(pageSource, /const \[wideLayout, setWideLayout\] = useState\(false\)/);
  assert.match(pageSource, /label=\{wideLayout \? '恢复标准宽度' : '切换宽屏显示'\}/);
  assert.match(pageSource, /aria-pressed=\{wideLayout\}/);
  assert.match(pageSource, /className="hidden sm:block"/);
  assert.doesNotMatch(pageSource, /localStorage|sessionStorage/);
});

test('宽屏模式同步扩展分享页标题、顶部栏与消息列表', () => {
  assert.match(pageSource, /wideLayout \? 'max-w-none' : 'max-w-4xl'/);
  assert.match(pageSource, /wideLayout \? 'max-w-none' : 'max-w-3xl'/);
  assert.match(pageSource, /<PublicShareMessageList snapshot=\{state\.data\.snapshot\} wideLayout=\{wideLayout\} full=\{exporting\} \/>/);
  assert.match(messageListSource, /wideLayout \? 'max-w-none' : 'max-w-3xl'/);
  assert.doesNotMatch(pageSource, /max-w-\[90rem\]/);
  assert.doesNotMatch(messageListSource, /max-w-\[90rem\]/);
});
