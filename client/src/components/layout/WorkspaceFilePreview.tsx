import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore } from '../../stores/chat';
import RightPanel from './RightPanel';

export default function WorkspaceFilePreview() {
  const { tabs, activeTabId, visible, pinned, width, hide, closeAll, closeTab, selectTab } = useChatStore(useShallow(state => ({
    tabs: state.rightPanelTabs, activeTabId: state.activeTabId, visible: state.panelVisible, pinned: state.rightPanelPinned,
    width: state.rightPanelWidth, hide: state.hideRightPanel, closeAll: state.closeAllRightPanelTabs,
    closeTab: state.closeRightPanelTab, selectTab: state.setActiveTabId,
  })));

  useEffect(() => () => closeAll({ report: false }), [closeAll]);
  useEffect(() => {
    if (!visible || pinned) return;
    const handleClick = (event: MouseEvent) => {
      if (event.target instanceof Element && !event.target.closest('[data-right-panel], [data-overlay-root], [data-file-preview-trigger], .md-link-file')) {
        hide();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [visible, pinned, hide]);

  return <RightPanel tabs={tabs} activeTabId={activeTabId} panelVisible={visible} width={width}
    onClose={() => closeAll()} onCloseTab={closeTab} onSelectTab={selectTab} />;
}
