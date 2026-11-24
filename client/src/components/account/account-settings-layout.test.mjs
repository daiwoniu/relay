import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const component = fs.readFileSync(new URL('./AccountSettingsDialog.tsx', import.meta.url), 'utf8');

test('账号设置按桌面侧栏和移动端分段导航组织内容', () => {
  assert.match(component, /import PanelShell/);
  assert.match(component, /import SettingsNavigation/);
  assert.match(component, /label="账号设置分类"/);
  assert.match(component, /bodyRole=\{mobile \? undefined : 'tabpanel'\}/);
  assert.match(component, /<SettingsNavigation/);
  assert.match(component, /mobile=\{mobile\}/);
  assert.doesNotMatch(component, /bg-gradient-to-l/);
  assert.match(component, /mobileCategories \? <SettingsNavigation[^\n]+presentation="list"/);
  assert.match(component, /backLabel="返回设置分类"/);
});

test('设置中心仅覆盖当前账号的个人、安全、新对话、外观和通知', () => {
  assert.match(component, /id: 'profile',[\s\S]*?label: '个人资料'/);
  assert.match(component, /id: 'security',[\s\S]*?label: '登录与安全'/);
  assert.match(component, /id: 'project',[\s\S]*?label: '新对话默认值', description: '默认项目、引擎与模型'/);
  assert.match(component, /id: 'appearance',[\s\S]*?label: '外观'/);
  assert.match(component, /id: 'notifications',[\s\S]*?label: '通知与提示音'/);
  assert.doesNotMatch(component, /成员管理|createMember|listUsers/);
});

test('新对话设置使用默认项目、联动引擎与模型选择', () => {
  assert.match(component, /aria-label="个人默认项目"/);
  assert.match(component, /filterSelectableProjects\(projects, user.id\)/);
  assert.match(component, /<DefaultEnginePicker value=\{user\.defaultEngine\}/);
  assert.match(component, /不可用时会临时使用其他可用引擎，不会修改这里的选择/);
  assert.match(component, /setDefaultEngine\(engine\)/);
  assert.match(component, /loadModels\(user\.defaultEngine, \{ refresh: true \}\)/);
  assert.match(component, /<AccountModelSettings/);
  assert.match(component, /key=\{`\$\{user.id\}:\$\{user.defaultEngine\}`\}/);
  assert.match(component, /setDefaultModel\(preferences.modelId, preferences\)/);
  assert.match(component, /unavailable=\{defaultModelCatalogUnavailable\}/);
  assert.doesNotMatch(component, /account-default-reasoning|account-default-speed/);
  assert.match(component, /defaultModelCatalog\?\.error/);
});

test('外观与通知作为设置中心分类嵌入且复用原有业务组件', () => {
  assert.match(component, /minimizedTitle="设置中心"/);
  assert.match(component, /<ThemeSettingsDialog[\s\S]*embedded/);
  assert.match(component, /<NotificationSettingsDialog[\s\S]*embedded/);
  assert.match(component, /size="settings"/);
  assert.match(component, /flex h-full min-h-0 flex-col/);
  assert.match(component, /embedded-settings-content/);
  assert.match(component, /panel-shell__body--nested-scroll/);
});

test('账号设置分类支持方向键导航并提供足够移动端触控高度', () => {
  assert.match(component, /<SettingsNavigation/);
  assert.match(component, /onChange=\{requestSectionChange\}/);
});

test('账号设置仅在弹窗打开时重置分类且所有分类关联同一个内容面板', () => {
  assert.match(component, /const wasOpenRef = useRef\(false\)/);
  assert.match(component, /if \(open && !wasOpenRef\.current\) \{\s*setActiveSection\('profile'\)/);
  assert.doesNotMatch(component, /setActiveSection\('profile'\);\s*setDisplayName/);
  assert.doesNotMatch(component, /\[open, user\?\.id, user\?\.displayName, user\?\.role\]/);
  assert.match(component, /panelId="account-settings-panel"/);
  assert.match(component, /bodyId="account-settings-panel" bodyRole=\{mobile \? undefined : 'tabpanel'\}/);
  assert.doesNotMatch(component, /account-settings-panel-\$\{section\.id\}/);
});

test('账号设置复用共享字段、反馈和按钮原语', () => {
  assert.match(component, /import \{[\s\S]*FormField[\s\S]*FormFeedback[\s\S]*formControlClassName[\s\S]*primaryFormButtonClassName[\s\S]*secondaryFormButtonClassName[\s\S]*\} from '\.\.\/ui\/FormControls'/);
  assert.doesNotMatch(component, /function Field\(/);
  assert.doesNotMatch(component, /const inputClass =/);
  assert.doesNotMatch(component, /const primaryButton =/);
  assert.doesNotMatch(component, /const secondaryButton =/);
  assert.match(component, /<FormFeedback message=\{profileError \|\| profileMessage\} error=\{Boolean\(profileError\)\}/);
});

test('切换分类重置正文位置，副作用不返回滚动 API 的返回值', () => {
  assert.match(component, /useEffect\(\(\) => \{\s*const body = settingsBodyRef\.current;\s*if \(body\) body\.scrollTop = 0;\s*\}, \[activeSection, mobileDetail\]\)/);
  assert.doesNotMatch(component, /settingsBodyRef\.current\?\.scrollTo/);
});
