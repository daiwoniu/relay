import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const main = await readFile(new URL('../main.tsx', import.meta.url), 'utf8');
const context = await readFile(new URL('./ThemeContext.tsx', import.meta.url), 'utf8');
const runtime = await readFile(new URL('./theme-runtime.ts', import.meta.url), 'utf8');
const auth = await readFile(new URL('../auth/AuthContext.tsx', import.meta.url), 'utf8');
const backdrop = await readFile(new URL('../components/theme/ThemeBackdrop.tsx', import.meta.url), 'utf8');
const index = await readFile(new URL('../../index.html', import.meta.url), 'utf8');

test('Router 在认证与主题层外并让公开分享状态可随路由更新', () => {
  assert.ok(main.indexOf('<BrowserRouter>') < main.indexOf('<ApplicationProviders />'));
  assert.match(main, /const location = useLocation\(\)/);
  assert.match(main, /skipInitialCheck=\{isPublicSharePath\(location\.pathname\)\}/);
  assert.ok(main.indexOf('<AuthProvider') < main.indexOf('<ThemeProvider>'));
});

test('主题上下文按作用域隔离账号外观并只在工作区写首屏镜像', () => {
  assert.match(context, /resolveThemeScope\(location\.pathname, status\)/);
  assert.match(context, /scope === 'workspace' \? previewSettings \?\? settings : guestSettings/);
  assert.match(context, /useLayoutEffect\([\s\S]*applyThemeRuntime/);
  assert.match(context, /writeCachedThemeSettings\(userId, remote\);\s+writeThemeBootstrap\(remote\)/);
  assert.match(context, /if \(!userId \|\| scope !== 'workspace'\) return/);
});

test('退出与认证过期在状态切换前同步清理首屏镜像', () => {
  assert.match(auth, /resetThemeBootstrapFromLocalPreference\(\);\s+setUser\(null\)/);
  assert.match(auth, /useLayoutEffect\([\s\S]*skipInitialCheck[\s\S]*'loading'/);
});

test('首屏脚本公开分享不读取工作区镜像并设置完整根属性', () => {
  assert.match(index, /publicShare = \/\^\\\/share/);
  assert.match(index, /if \(!publicShare\)[\s\S]*relay_theme_bootstrap_v2/);
  for (const attribute of ['theme', 'themePreference', 'colorStyle', 'textScale', 'themeScope']) {
    assert.match(index, new RegExp(`dataset\\.${attribute}`));
  }
});

test('首屏浏览器栏颜色与运行时保持相同的明暗及色彩风格映射', () => {
  const mapping = /theme === 'dark'\s*\? \(colorStyle === 'aurora' \? '#12131d' : '#181818'\)\s*:\s*\(colorStyle === 'aurora' \? '#f7f8ff' : '#ffffff'\)/;
  const runtimeMapping = /effectiveTheme === 'dark'\s*\? colorStyle === 'aurora' \? '#12131d' : '#181818'\s*:\s*colorStyle === 'aurora' \? '#f7f8ff' : '#ffffff'/;
  assert.match(index, mapping);
  assert.match(runtime, runtimeMapping);
  assert.match(index, /setAttribute\('content', browserChromeColor\)/);
});

test('运行时先清理旧作用域且迟到的背景图片不能覆盖新请求', () => {
  assert.match(runtime, /clearThemeRuntime\(root\);[\s\S]*root\.dataset\.theme = effectiveTheme/);
  assert.match(runtime, /delete root\.dataset\.themeScope/);
  assert.match(backdrop, /loadedUrl === requestedUrl/);
});
