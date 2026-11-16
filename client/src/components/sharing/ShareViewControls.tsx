import { useTheme } from '../../hooks/useTheme';
import IconActionButton from '../ui/IconActionButton';

export default function ShareViewControls({ wideLayout, onToggleWide, showWide = true }: { wideLayout: boolean; onToggleWide: () => void; showWide?: boolean }) {
  const { preference, effectiveTheme, cycleTheme } = useTheme();
  const themeName = preference === 'system' ? `系统·${effectiveTheme === 'dark' ? '暗色' : '浅色'}` : preference === 'dark' ? '暗色' : '浅色';
  const themeLabel = `切换主题（当前：${themeName}）`;
  return <>
    {showWide && <div className="hidden sm:block"><IconActionButton label={wideLayout ? '恢复标准宽度' : '切换宽屏显示'} variant="neutral" className="h-10 w-10 sm:h-7 sm:w-7" tooltipPlacement="bottom" aria-pressed={wideLayout} data-static-share-wide onClick={onToggleWide}>
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d={wideLayout ? 'M3 5l3 3-3 3m10-6-3 3 3 3' : 'M6 5 3 8l3 3m4-6 3 3-3 3'} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </IconActionButton></div>}
    <IconActionButton label={themeLabel} variant="neutral" className="h-10 w-10 sm:h-7 sm:w-7" tooltipPlacement="bottom" data-static-share-theme onClick={cycleTheme}>
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path data-static-share-theme-icon d={effectiveTheme === 'dark' ? 'M10.8 10.9A5 5 0 015.1 5.2 5.5 5.5 0 1010.8 10.9z' : 'M8 2.2v1.4M8 12.4v1.4M2.2 8h1.4M12.4 8h1.4M3.9 3.9l1 1M11.1 11.1l1 1M12.1 3.9l-1 1M4.9 11.1l-1 1M10.5 8A2.5 2.5 0 115.5 8a2.5 2.5 0 015 0z'} stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </IconActionButton>
  </>;
}
