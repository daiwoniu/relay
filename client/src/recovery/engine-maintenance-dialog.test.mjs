import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../components/system/EngineMaintenanceDialog.tsx', import.meta.url), 'utf8');

test('有新版时展示结构化中文概览、明确降级状态和官方入口', () => {
  assert.match(source, /engine\.updateAvailable &&/);
  assert.match(source, /engine\.releaseOverview/);
  assert.match(source, /版本概览/);
  assert.match(source, /查看官方说明/);
  assert.match(source, /target="_blank" rel="noopener noreferrer"/);
  assert.match(source, /该引擎暂未提供结构化版本说明/);
  assert.doesNotMatch(source, /releaseSummary|新版摘要/);
});
const concurrencySection = fs.readFileSync(new URL('../components/settings/EngineConcurrencySection.tsx', import.meta.url), 'utf8');
const serviceStyles = fs.readFileSync(new URL('../styles/service-status.css', import.meta.url), 'utf8');
const globalStyles = fs.readFileSync(new URL('../styles/global-base.css', import.meta.url), 'utf8');
const sidebar = fs.readFileSync(new URL('../components/layout/Sidebar.tsx', import.meta.url), 'utf8');
const userMenu = fs.readFileSync(new URL('../components/layout/UserMenu.tsx', import.meta.url), 'utf8');
test('引擎维护聚焦当前引擎状态且不重复说明 Relay 服务维护', () => {
  assert.doesNotMatch(source, /Relay 服务|Relay 前后端请使用服务维护|前端和后端维护保留/);
  assert.match(source, /presentation\.statusLabel/);
  assert.match(source, /版本维护/);
  assert.match(source, /instanceVersions/);
  assert.doesNotMatch(source, /Readiness<\/dt>/);
});
test('引擎并发归入各自维护面板且不再提供独立菜单入口', () => {
  assert.match(source, /EngineConcurrencySection engineId=\{engineId\}/);
  assert.match(concurrencySection, /filterEngineConcurrencyItems\(concurrencyByResourceKey, engineId\)/);
  assert.match(concurrencySection, /getNextCooldownRefreshDelay\(items, now, Date\.now\(\)\)/);
  assert.match(concurrencySection, /最大并发/);
  assert.match(concurrencySection, /当前活动/);
  assert.match(concurrencySection, /等待队列/);
  assert.match(concurrencySection, /运行诊断/);
  assert.doesNotMatch(sidebar, /EngineConcurrencyDialog|engineConcurrencyOpen|引擎并发/);
});
test('账号菜单使用单一引擎维护入口并展示聚合可用状态', () => {
  assert.match(userMenu, />引擎维护</);
  assert.match(userMenu, /onOpenEngineMaintenance\(\)/);
  assert.match(userMenu, /engineSummary\.engines\.filter/);
  assert.match(userMenu, /readiness === 'ready'/);
  assert.doesNotMatch(userMenu, /user-menu__engine-row/);
  assert.doesNotMatch(userMenu, /onRefreshEngine/);
  assert.doesNotMatch(userMenu, /user-menu__refresh/);
  assert.match(source, /EngineMaintenanceEnginePicker/);
  assert.doesNotMatch(source, /role="tablist"/);
  assert.match(source, /\.find\(\(item\) => item\.engineId === engineId\)/);
});
test('引擎维护覆盖桌面移动交互和多主题语义变量', () => {
  assert.match(source, /<PanelShell/);
  assert.match(source, /size="operations"/);
  assert.match(serviceStyles, /env\(safe-area-inset-bottom\)/);
  assert.match(source, /min-h-11/);
  assert.match(serviceStyles, /:focus-visible/);
  assert.match(globalStyles, /var\(--color-overlay-surface\)/);
  assert.match(serviceStyles, /\.engine-maintenance-control:not\(:disabled\):hover/);
  assert.doesNotMatch(serviceStyles, /\.engine-maintenance-control:hover/);
  assert.match(source, /ConfirmDialog/);
});

test('引擎维护使用桌面双列、移动单列和状态驱动渐进披露', () => {
  assert.match(source, /lg:grid-cols-2/);
  assert.match(source, /getEngineMaintenancePresentation/);
  assert.match(source, /版本与安装详情/);
  assert.match(source, /更多维护操作/);
  assert.match(source, /lg:hidden/);
  assert.match(source, /lg:flex-row/);
  assert.doesNotMatch(source, /Readiness<\/dt>/);
});

test('运行容量去除重复调度块并为移动端提供步进控件', () => {
  assert.match(concurrencySection, /aria-label="减少最大并发"/);
  assert.match(concurrencySection, /aria-label="增加最大并发"/);
  assert.match(concurrencySection, /运行诊断/);
  assert.doesNotMatch(concurrencySection, />调度状态<\/dt>/);
  assert.doesNotMatch(concurrencySection, /sm:grid-cols-3/);
});

test('引擎维护标题区与服务维护保持紧凑密度', () => {
  assert.match(source, /SessionEngineBadge engine=\{engineId\}/);
  assert.match(source, /title=\{`\$\{engine\?\.label \|\| engineId\} 维护`\}/);
  assert.match(source, /description=\{<span/);
  assert.match(source, /closeDisabled=\{interactionLocked\}/);
  assert.doesNotMatch(source, /engine-maintenance-header/);
});

test('两个引擎只在确认上下文披露升级与重启差异', () => {
  assert.match(source, /升级后需要重启/);
  assert.match(source, /Codex app-server 是常驻进程，重启后才会加载新版本/);
  assert.match(source, /新会话会使用新版本；验证失败时启动器会尝试回退/);
  assert.doesNotMatch(source, /升级无需额外重启：/);
});

test('引擎维护执行中展示统一动态进度，终态保留静态结果', () => {
  assert.match(source, /MaintenanceProgress/);
  assert.match(source, /state\.tracking[\s\S]*state\.operation\.message/);
  assert.match(source, /state\.operation\?\.status === 'completed'/);
  assert.match(source, /state\.operation\?\.status === 'failed'/);
  // 停滞的操作保持可交互与可关闭；只有活跃提交、中止和正常跟踪期间锁交互。
  assert.match(source, /interactionLocked = state\.submitting \|\| state\.aborting \|\| \(state\.tracking && !stalled\)/);
  // stalled 不依赖 tracking：轮询超时后操作仍在后台，提示与中止入口必须保留。
  assert.match(source, /stalled = state\.operation\?\.status === 'processing' && state\.operation\.stalled === true/);
  assert.match(source, /output=\{state\.operationOutput\}/);
  assert.match(source, /!state\.tracking && state\.operationOutput/);
});

test('引擎维护停滞时展示长时间无进展提示与继续等待、中止回退操作', () => {
  assert.match(source, /长时间无进展/);
  assert.match(source, /中止并回退/);
  assert.match(source, /关闭面板继续等待/);
  assert.match(source, /void state\.abort\(\)/);
});

test('引擎维护临时错误只属于当前打开的引擎面板', () => {
  assert.match(source, /if \(!open\) return null/);
  assert.match(source, /<EngineMaintenanceDialogContent key=\{engineId\} engineId=\{engineId\}/);
  assert.match(source, /useEngineMaintenance\(true, engineId\)/);
});

test('引擎维护面板不再读取或展示 Codex 账号额度', () => {
  assert.doesNotMatch(source, /CodexAccountCard|账号与额度|refreshCodexAccount/);
  assert.doesNotMatch(hookSource, /getCodexAccount|codexAccount/);
});

test('最新版本与版本概览都显示发布时间', () => {
  assert.match(source, /最新版本<\/dt><dd[^>]*>[\s\S]*?<time dateTime=\{releaseDateTime\}[^>]*>发布于 \{releaseTime\}<\/time>/);
  const overviewCard = source.slice(source.indexOf('function ReleaseOverviewCard'), source.indexOf('function EngineVersionSection'));
  assert.match(overviewCard, /<time dateTime=\{releaseDateTime\}[^>]*>发布于 \{releaseTime\}<\/time>/);
});

const hookSource = fs.readFileSync(new URL('../hooks/useEngineMaintenance.ts', import.meta.url), 'utf8');
test('引擎维护成功后失效对应引擎的模型目录', () => {
  assert.match(hookSource, /terminal\.status === 'completed'[\s\S]*invalidate\(terminal\.engineId\)/);
});

test('引擎维护成功后刷新并发资源快照', () => {
  assert.match(hookSource, /getEngineConcurrency/);
  assert.match(hookSource, /replaceConcurrencySnapshot/);
  assert.match(hookSource, /terminal\.status === 'completed'[\s\S]*getEngineConcurrency/);
});

test('引擎维护轮询超时或异常后解除本地跟踪锁定', () => {
  assert.match(hookSource, /const \[tracking, setTracking\] = useState\(false\)/);
  assert.match(hookSource, /setTracking\(true\)[\s\S]*pollEngineMaintenanceOperation/);
  assert.match(hookSource, /finally \{[\s\S]*operationAbortRef\.current === controller[\s\S]*setTracking\(false\)/);
  assert.match(hookSource, /return \{[^}]*tracking,/);
});
