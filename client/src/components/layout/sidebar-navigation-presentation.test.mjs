import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sidebar = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
const workbench = readFileSync(new URL('./SidebarWorkbench.tsx', import.meta.url), 'utf8');
const navigation = readFileSync(new URL('./SidebarNavigationItems.tsx', import.meta.url), 'utf8');
const resourceDialog = readFileSync(new URL('./UserResourceDialog.tsx', import.meta.url), 'utf8');
const loadingState = readFileSync(new URL('./SidebarLoadingState.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../../styles/global-base.css', import.meta.url), 'utf8');

test('侧栏顶部控制区共享紧凑控件与局部状态语义', () => {
  assert.match(workbench, /sidebar-workbench/);
  assert.match(workbench, /sidebar-primary-action/);
  assert.match(workbench, /sidebar-search/);
  assert.match(sidebar, /sidebar-navigation-state/);
  assert.match(resourceDialog, /title="用户资源"/);
  assert.match(workbench, /sidebar-resource-view/);
  assert.match(loadingState, /sidebar-navigation-state/);
  assert.match(workbench, /<div className="sidebar-brand/);
  assert.doesNotMatch(workbench, /<button className="sidebar-brand/);
});

test('分组、项目和会话行使用稳定的资源导航骨架', () => {
  assert.match(navigation, /sidebar-group/);
  assert.match(navigation, /sidebar-project-row/);
  assert.match(navigation, /sidebar-session-row/);
  assert.match(navigation, /sidebar-session-row--active/);
  assert.match(navigation, /sidebar-resource-actions/);
  assert.match(navigation, /sidebar-resource-status/);
  assert.match(navigation, /sidebar-project-row__count/);
  assert.match(navigation, /sidebar-resource-row--dragging/);
});

test('项目空态只在导航就绪且未搜索时出现，并区分全部置顶与零会话', () => {
  assert.match(sidebar, /const canShowProjectEmptyState = navigationReady && !searchMode/);
  assert.match(navigation, /const emptyLabel = sessionCount === 0 \? '暂无会话' : pinnedSessionCount > 0 \? `\$\{pinnedSessionCount\} 个会话在置顶`/);
  assert.match(sidebar, /const hasNoProjects = canShowProjectEmptyState && scopedProjectCount === 0/);
  assert.match(sidebar, /canShowAllProjects && \(\s*<button type="button" onClick=\{toggleShowAllProjects\}/);
});

test('共享样式约束当前会话标记、按需状态槽和移动触控热区', () => {
  assert.match(styles, /\.sidebar-session-row--active::before/);
  assert.match(styles, /\.sidebar-resource-status/);
  assert.match(styles, /\.sidebar-resource-actions/);
  const mobileRules = styles.slice(styles.indexOf('@media (max-width: 1023px)'));
  assert.match(mobileRules, /\.sidebar-workbench \{[\s\S]*?gap: 0\.375rem;[\s\S]*?padding: 0\.5rem 0\.625rem/);
  assert.match(mobileRules, /\.sidebar-brand \{ min-height: 1\.75rem/);
  assert.match(mobileRules, /\.sidebar-primary-action \{ min-height: 2\.125rem/);
  assert.match(mobileRules, /\.sidebar-resource-view \{ min-height: 2\.75rem/);
  assert.match(mobileRules, /\.sidebar-resource-action-hitbox \{[\s\S]*?width: 2rem;[\s\S]*?height: 2\.75rem/);
  assert.match(mobileRules, /\.sidebar-resource-status \{ width: 1\.5rem; height: 2\.75rem/);
  assert.match(mobileRules, /\.sidebar-navigation-skeleton__row \{ height: 2\.75rem; \}/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.sidebar-resource-status/);
});

test('桌面端会话只给指示器留位，更多按钮叠加标题末尾且统一右侧留白', () => {
  assert.match(
    navigation,
    /sidebar-project-row__count[\s\S]*?metadataHidden \? 'opacity-0'[\s\S]*?sidebar-resource-actions sidebar-resource-actions--overlay/,
  );
  assert.match(
    navigation,
    /sidebar-session-row__tail[\s\S]*?sidebar-resource-status[\s\S]*?<SessionStatusIcon[\s\S]*?sidebar-resource-actions sidebar-session-actions/,
  );
  assert.match(styles, /\.sidebar-resource-actions--overlay \{[\s\S]*?position: absolute;[\s\S]*?right: 0\.5rem;/);
  assert.doesNotMatch(navigation, /aria-hidden=\{hasVisibleStatus \? undefined : true\}/);
  assert.match(styles, /\.sidebar-session-row \{ padding-right: 0\.5rem; \}/);
  assert.match(styles, /\.sidebar-session-actions \{[\s\S]*?position: absolute;[\s\S]*?right: 0;[\s\S]*?width: 1\.5rem;/);
  assert.match(styles, /\.sidebar-session-row__tail\[data-has-indicators\] \.sidebar-session-actions \{ right: calc\(100% \+ 0\.25rem\); \}/);
  assert.match(styles, /\.sidebar-session-actions::before \{[\s\S]*?pointer-events: none;[\s\S]*?linear-gradient/);
  assert.match(styles, /\.sidebar-session-actions \{ position: static; width: 2rem;/);
  assert.match(navigation, /data-has-indicators=\{hasVisibleStatus \|\| session.codex_archived \? true : undefined\}/);
  assert.doesNotMatch(navigation.slice(navigation.indexOf('export function SessionRow(')), /<PinIcon/);
});

test('运行态使用CSS圆环而非字符转圈，消息区与侧栏共享图标组件', () => {
  const icons = readFileSync(new URL('../ui/ExecutionStatusIcon.tsx', import.meta.url), 'utf8');
  const assistant = readFileSync(new URL('../messages/AssistantMessage.tsx', import.meta.url), 'utf8');
  assert.match(icons, /execution-status-spinner[\s\S]*?rounded-full border-2[\s\S]*?color-status-track[\s\S]*?animate-spin/);
  assert.match(icons, /borderTopColor:/);
  assert.doesNotMatch(icons, /◌/);
  assert.match(assistant, /<ExecutionStatusIcon status=\{visualState\}/);
  const messageStyles = readFileSync(new URL('../../styles/message-ui.css', import.meta.url), 'utf8');
  const reducedMotion = messageStyles.slice(messageStyles.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reducedMotion, /\.execution-status-spinner,[\s\S]*?animation: none;/);
  assert.doesNotMatch(reducedMotion, /\.assistant-message__status-icon\.animate-spin/);
});

test('项目行显示会话数量并为拖拽源提供明确抬升', () => {
  assert.match(navigation, /aria-label=\{`\$\{sessionCount\} 个会话`\}/);
  assert.match(styles, /\.sidebar-resource-row--dragging \{[\s\S]*?box-shadow:/);
});

test('用户资源复用共享搜索与列表状态并区分空结果', () => {
  assert.match(resourceDialog, /import \{ ListSearchField, ListState \} from '\.\.\/ui\/ListControls'/);
  assert.match(resourceDialog, /<ListSearchField/);
  assert.match(resourceDialog, /onClear=\{\(\) => setQuery\(''\)\}/);
  assert.match(resourceDialog, /<ListState kind="loading"/);
  assert.match(resourceDialog, /<ListState kind="error"[\s\S]*?onRetry=/);
  assert.match(resourceDialog, /normalizedQuery \? '没有匹配的账号' : '当前没有其他账号'/);
});

test('侧栏搜索复用共享输入和状态且错误不会叠加空结果', () => {
  assert.match(workbench, /import \{ ListSearchField \} from '\.\.\/ui\/ListControls'/);
  assert.match(workbench, /<ListSearchField/);
  assert.match(sidebar, /import \{ ListState \} from '\.\.\/ui\/ListControls'/);
  assert.match(sidebar, /<ListState kind="loading"/);
  assert.match(sidebar, /<ListState kind="error"/);
  assert.match(sidebar, /<ListState kind="empty"/);
  assert.match(sidebar, /searchStatus === 'ready' && pinnedItems\.length === 0 && projectItems\.length === 0/);
  assert.doesNotMatch(sidebar, /searchStatus === 'idle' && pinnedItems\.length === 0/);
});
