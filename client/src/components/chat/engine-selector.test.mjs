import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { formatEngineUnavailableReason, formatEngineVersion } from './engine-selector-presentation.ts';

const source = fs.readFileSync(new URL('./EngineSelector.tsx', import.meta.url), 'utf8');
const badgeSource = fs.readFileSync(new URL('./SessionEngineBadge.tsx', import.meta.url), 'utf8');
const catalogSource = fs.readFileSync(new URL('../../engine/catalog.ts', import.meta.url), 'utf8');

test('流式重渲染时保持关闭回调稳定以避免面板反复重定位', () => {
  assert.match(source, /import \{ useCallback, useState \} from 'react'/);
  assert.match(source, /const close = useCallback\(\(\) => setAnchorRect\(null\), \[\]\)/);
});

test('引擎选择器使用与项目选择一致的品牌化面板', () => {
  assert.match(source, /import Popover from ['"]\.\.\/ui\/Popover['"]/);
  assert.match(catalogSource, /vendor: 'OpenAI', position: '全球前沿的 AI 编程能力'/);
  assert.match(catalogSource, /vendor: '腾讯云', position: '深耕国内开发者生态'/);
  assert.match(catalogSource, /vendor: 'Anysphere', position: '开源开放，灵活接入多种模型'/);
  assert.match(source, /status\.version/);
  assert.doesNotMatch(source, /<select/);
});

test('引擎选项使用两行信息并与左侧徽标垂直居中', () => {
  assert.match(source, /flex w-full items-center gap-3/);
  assert.match(source, /flex min-w-0 flex-1 flex-col justify-center/);
  assert.match(source, /\{status\.label\}[\s\S]*\{version\}/);
  assert.match(source, /formatEngineUnavailableReason\(status\.availabilityStage, status\.code, status\.message\)/);
  assert.match(source, /unavailableReason\}[\s\S]*\{brand\.vendor\} · \{brand\.position\}/);
  assert.doesNotMatch(source, />当前项目偏好<\/span>/);
  assert.doesNotMatch(source, /`可用\$\{version/);
});

test('不可用原因归一为简单直接的短标签', () => {
  assert.equal(formatEngineUnavailableReason('not_installed', 'CODEX_CLI_NOT_INSTALLED', '未安装 Codex CLI'), '未安装');
  assert.equal(formatEngineUnavailableReason('installed_auth_required', 'CODEBUDDY_NOT_READY', 'CodeBuddy 认证未通过'), '未登录');
  assert.equal(formatEngineUnavailableReason('readiness_stale', 'CODEBUDDY_NOT_READY', 'CodeBuddy 认证与 readiness 记录已过期'), '待复验');
  assert.equal(formatEngineUnavailableReason('readiness_failed', 'CODEX_PROCESS_NOT_READY', 'Codex 服务未就绪'), '未就绪');
  assert.equal(formatEngineUnavailableReason(undefined, 'UNKNOWN', '连接发生异常'), '不可用');
});

test('引擎选项复用会话品牌徽标的大尺寸样式', () => {
  assert.match(source, /<SessionEngineBadge engine=\{status\.id\} size="panel" \/>/);
  assert.doesNotMatch(source, /function EngineMark/);
  assert.match(badgeSource, /size\?: 'compact' \| 'menu' \| 'panel'/);
  assert.match(badgeSource, /h-8 min-w-8 rounded-lg/);
  assert.match(badgeSource, /getEnginePresentation\(engine\)/);
  assert.match(badgeSource, /presentation\.shortName/);
  assert.match(badgeSource, /presentation\.badgeColor/);
});

test('用户菜单可使用与普通菜单图标等宽的方形徽标', () => {
  assert.match(badgeSource, /size\?: 'compact' \| 'menu' \| 'panel'/);
  assert.match(badgeSource, /size === 'menu'[\s\S]*?h-\[14px\] w-\[14px\]/);
  assert.match(badgeSource, /size === 'menu'[\s\S]*?font-bold tracking-normal/);
  assert.doesNotMatch(badgeSource, /font-semibold leading-none tracking-tight text-white shadow-sm/);
});

test('引擎版本统一展示为纯语义版本', () => {
  assert.equal(formatEngineVersion('codex-cli 0.147.0'), 'v0.147.0');
  assert.equal(formatEngineVersion('2.133.1'), 'v2.133.1');
  assert.equal(formatEngineVersion('v2.133.1'), 'v2.133.1');
  assert.equal(formatEngineVersion(null), null);
});

test('移动端面板使用 Popover 安全宽度，桌面端才限制最大宽度', () => {
  assert.match(source, /className=\{mobile \? '' : 'w-\[min\(21rem,calc\(100vw-1\.5rem\)\)\]'\}/);
});

test('移动端输入框引擎触发器只显示品牌缩写，桌面端保留全称', () => {
  assert.match(source, /getEnginePresentation\(value\)\.shortName/);
  assert.match(source, /mobile \? getEnginePresentation\(value\)\.shortName : engineLabel\(value\)/);
  assert.match(source, /mobile \? 'shrink-0' : 'shrink'/);
  assert.match(source, /mobile \? 'shrink-0' : 'truncate'/);
  assert.match(source, /`查看 \$\{engineLabel\(value\)\} 引擎详情`/);
});

test('引擎选择面板标题区使用紧凑间距', () => {
  const sectionSource = fs.readFileSync(new URL('../ui/PopoverSection.tsx', import.meta.url), 'utf8');
  const styles = fs.readFileSync(new URL('../../styles/message-ui.css', import.meta.url), 'utf8');
  assert.match(source, /<PopoverSection/);
  assert.match(sectionSource, /popover-section__header/);
  assert.match(styles, /\.popover-section__header \{[^}]*padding: \.625rem \.875rem/);
  assert.doesNotMatch(source, /px-3\.5 py-3/);
});

test('引擎选择器保留不可用项并显示稳定原因', () => {
  assert.match(source, /!status\.available/);
  assert.match(source, /status\.message/);
});

test('CodeBuddy readiness 过期时就地复验，不误打开维护面板', () => {
  assert.match(source, /status\.availabilityStage === 'readiness_stale'/);
  assert.match(source, /await recheckEngineReadiness\(status\.id\)/);
  assert.match(source, /onStatusesChange\?\.\(response\.engines\)/);
  assert.match(source, /aria-busy=\{rechecking === status\.id\}/);
  assert.match(source, /rechecking === status\.id \? '检测中…' : unavailableReason/);
});

test('CodeBuddy 复验只在用户选择上下文未变化时自动选中', () => {
  assert.match(source, /const commitSelection = onChange\(status\.id\)/);
  assert.match(source, /commitSelection\(\)/);
  const chatView = fs.readFileSync(new URL('./ChatView.tsx', import.meta.url), 'utf8');
  assert.match(chatView, /if \(intent !== engineSelectionContextRef\.current\) return/);
});

test('已有会话锁定来源引擎但仍可打开只读详情', () => {
  assert.match(source, /locked/);
  assert.match(source, /engineLabel\(value\)/);
  assert.match(source, /固定使用所选引擎，无法更改/);
  assert.doesNotMatch(source, /当前会话已固定使用此引擎/);
  assert.match(source, /aria-haspopup="dialog"/);
  assert.match(source, /\{!locked && \([\s\S]*group-aria-expanded:rotate-180/);
});

test('新会话选择器明确提示开始会话后不可更改引擎', () => {
  assert.match(source, /开始会话后将固定使用所选引擎，无法更改/);
  assert.doesNotMatch(source, /保存为当前项目偏好/);
});

test('引擎状态尚未加载时显示检查状态且 ChatView 禁止首次发送', () => {
  assert.match(source, /statuses\.length === 0/);
  assert.match(source, /正在检查可用引擎/);
  const chatView = [
    './ChatView.tsx',
    './ChatViewPresentation.tsx',
    './use-engine-statuses.ts',
  ].map((file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
  assert.match(chatView, /engineStatusState.*'loading'/s);
  assert.match(chatView, /无法获取引擎状态，请稍后重试/);
  assert.match(chatView, /当前没有可用的 AI 引擎/);
  assert.match(chatView, /engineStatusNotice,/);
  assert.match(chatView, /正在检查可用引擎…', tone: 'processing'/);
  assert.match(chatView, /无法获取引擎状态，请稍后重试', tone: 'danger'/);
  assert.match(chatView, /ENGINE_STATUS_RETRY_DELAYS_MS/);
  assert.match(chatView, /window\.addEventListener\('online', refreshEngineStatuses\)/);
  assert.match(chatView, /setEngineStatusState\('ready'\)/);
  assert.match(chatView, /const applyEngineStatusSnapshot = useCallback\(\(statuses: EngineStatusDto\[\]\) => \{[\s\S]*cancelPendingRequest\(\);[\s\S]*setEngineStatuses\(statuses\);[\s\S]*\}, \[cancelPendingRequest\]\);/);
});

test('未绑定草稿仍可选择引擎并且只有发送动作要求已选择可用引擎', () => {
  const chatView = [
    './ChatView.tsx',
    './ChatViewPresentation.tsx',
  ].map((file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
  const chatInput = [
    './ChatInput.tsx',
    './ChatInputMetadataBar.tsx',
    './ChatInputSubmitControl.tsx',
  ].map((file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
  assert.match(chatView, /const draftSession = Boolean\(currentSession && !currentSession\.engine\)/);
  assert.match(chatView, /engineLocked: !draftSession && Boolean\(currentSession\?\.engine\)/);
  assert.match(chatView, /const selectedEngine = currentSession\?\.engine \?\? newSessionEngine/);
  assert.match(chatInput, /const engineSelectionRequired = !selectedEngine/);
  assert.doesNotMatch(chatInput, /disabled=\{isAwaitingAction\}/);
  assert.match(chatView, /selectedEngine && !currentEngineStatus\?\.available/);
  assert.match(chatInput, /engineUnavailable=\{engineUnavailable\}/);
  assert.match(chatInput, /if \(isQueued\)[\s\S]*onClick=\{onCancelQueued\}/);
  assert.match(chatInput, /disabled=\{engineUnavailable \|\| engineSelectionRequired \|\| isSubmitting \|\|/);
});

test('新会话按账号默认引擎选择且不再读写项目级引擎记忆', () => {
  const chatView = fs.readFileSync(new URL('./ChatView.tsx', import.meta.url), 'utf8');
  assert.match(chatView, /resolveDefaultEngine\(preferred, engineStatuses\)/);
  assert.doesNotMatch(chatView, /project-engine-preference|localStorage|readProjectEnginePreference|writeProjectEnginePreference/);
});
