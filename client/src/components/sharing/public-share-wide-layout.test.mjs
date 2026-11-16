import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const pageSource = fs.readFileSync(new URL('./PublicSharePage.tsx', import.meta.url), 'utf8');
const messageListSource = fs.readFileSync(new URL('./PublicShareMessageList.tsx', import.meta.url), 'utf8');
const controlsSource = fs.readFileSync(new URL('./ShareViewControls.tsx', import.meta.url), 'utf8');
const contentSource = fs.readFileSync(new URL('./SharePageContent.tsx', import.meta.url), 'utf8');

test('公开分享页提供仅在桌面显示的宽屏切换按钮', () => {
  assert.match(pageSource, /const \[wideLayout, setWideLayout\] = useState\(false\)/);
  assert.match(controlsSource, /label=\{wideLayout \? '恢复标准宽度' : '切换宽屏显示'\}/);
  assert.match(controlsSource, /aria-pressed=\{wideLayout\}/);
  assert.match(controlsSource, /className="hidden sm:block"/);
  assert.doesNotMatch(pageSource, /localStorage|sessionStorage/);
});

test('宽屏模式同步扩展分享页标题、顶部栏与消息列表', () => {
  assert.match(pageSource, /wideLayout \? 'max-w-none' : 'max-w-4xl'/);
  assert.match(contentSource, /wideLayout \? 'max-w-none' : 'max-w-3xl'/);
  assert.match(pageSource, /<SharePageContent data=\{state\.data\} wideLayout=\{wideLayout\} full=\{exporting\} \/>/);
  assert.match(contentSource, /<PublicShareMessageList snapshot=\{data\.snapshot\} wideLayout=\{wideLayout\} full=\{full\} \/>/);
  assert.match(messageListSource, /wideLayout \? 'max-w-none' : 'max-w-3xl'/);
  assert.doesNotMatch(pageSource, /max-w-\[90rem\]/);
  assert.doesNotMatch(messageListSource, /max-w-\[90rem\]/);
});
