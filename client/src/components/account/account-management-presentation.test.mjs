import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const component = readFileSync(new URL('./AccountManagementDialog.tsx', import.meta.url), 'utf8');

test('账号管理作为独立面板承载账号生命周期操作', () => {
  assert.match(component, /title="账号管理"/);
  assert.match(component, /创建和维护 Relay 登录账号/);
  assert.match(component, /createMember/);
  assert.match(component, /setUserDisabled/);
  assert.match(component, /resetUserPassword/);
  assert.match(component, />创建账号</);
  assert.doesNotMatch(component, /成员管理/);
});

test('账号管理提供加载、空态、错误与移动端操作布局', () => {
  assert.match(component, /加载账号中…/);
  assert.match(component, /当前没有其他账号/);
  assert.match(component, /role="alert"/);
  assert.match(component, /mobile \? 'hidden'/);
  assert.match(component, /secondaryFormButtonClassName/);
});

test('账号管理在重新打开和取消重置时清除全部密码', () => {
  assert.match(component, /const clearResetCredentials = \(\) => \{/);
  assert.match(component, /setAdminPassword\(''\)/);
  assert.match(component, /setResetPassword\(''\)/);
  assert.match(component, /setResetConfirmation\(''\)/);
  assert.match(component, /setMemberPassword\(''\)/);
  assert.match(component, /if \(open\) clearSensitiveFields\(\)/);
  assert.match(component, /onClick=\{cancelReset\}/);
});

test('停用账号使用共享危险确认弹窗并明确影响范围', () => {
  assert.match(component, /import ConfirmDialog from '\.\.\/ui\/ConfirmDialog'/);
  assert.match(component, /const \[disableTarget, setDisableTarget\] = useState<PublicUserDto \| null>\(null\)/);
  assert.match(component, /<ConfirmDialog[\s\S]*?title="停用账号？"[\s\S]*?tone="danger"/);
  assert.match(component, /label: '账号'/);
  assert.match(component, /该账号会立即退出所有已登录设备/);
  assert.match(component, /排队中的任务会被取消/);
  assert.match(component, /confirmLabel="停用账号"/);
  assert.doesNotMatch(component, /window\.confirm/);
});

test('创建账号可多选初始协作项目，已有账号可改添加项目权限', () => {
  assert.match(component, /初始协作项目/);
  assert.match(component, /可多选，创建后即可直接使用这些项目/);
  assert.match(component, /selectedProjectIds.includes\(project.id\)/);
  assert.match(component, /setUserCanCreateProject/);
  assert.match(component, /item\.role !== 'admin' && <label/);
  assert.match(component, /updateProjectPermission\(item, event\.target\.checked\)/);
  assert.doesNotMatch(component, /<select multiple/);
  assert.ok(component.indexOf('初始协作项目') < component.indexOf("createPending ? '创建中…' : '创建账号'"));
});

test('账号管理复用共享字段、反馈和按钮原语', () => {
  assert.match(component, /import \{[\s\S]*FormField[\s\S]*FormFeedback[\s\S]*formControlClassName[\s\S]*primaryFormButtonClassName[\s\S]*secondaryFormButtonClassName[\s\S]*\} from '\.\.\/ui\/FormControls'/);
  assert.doesNotMatch(component, /function Field\(/);
  assert.doesNotMatch(component, /const inputClass =/);
  assert.doesNotMatch(component, /const primaryButton =/);
  assert.doesNotMatch(component, /const secondaryButton =/);
  assert.match(component, /<FormFeedback message=\{createError \|\| createMessage\} error=\{Boolean\(createError\)\}/);
});
