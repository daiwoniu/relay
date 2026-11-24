import { appPageRoutes } from '../../../../server/src/analytics/pages.ts';
import { featureAction, useFeatureView } from '../../analytics/features';
import UserMenuIcon from '../icons/UserMenuIcon';
import PanelShell from '../ui/PanelShell';
import MenuDestinationIcon from './MenuDestinationIcon';

export type AdministrationPanel = 'accounts' | 'pages' | 'server' | 'engines';

const sections = [
  { title: '平台管理', items: [
    { icon: 'accounts', label: 'Relay 账号管理', panel: 'accounts' },
    { icon: 'feishu', label: '飞书管理', href: appPageRoutes.feishu_bots.path },
    { icon: 'pages', label: '页面托管', panel: 'pages' },
    { icon: 'analytics', label: '访问与功能使用', href: appPageRoutes.analytics_admin.path },
  ] },
  { title: '运行与维护', items: [
    { icon: 'server', label: 'Relay 维护', panel: 'server' },
    { icon: 'engines', label: '引擎维护', panel: 'engines' },
  ] },
] as const;

export default function AdministrationCenter({ open, mobile, onClose, onSelect }: {
  open: boolean;
  mobile: boolean;
  onClose: () => void;
  onSelect: (panel: AdministrationPanel) => void;
}) {
  useFeatureView('user_menu', open, 'user_menu', 'open_admin_center');
  return (
    <PanelShell open={open} onClose={onClose} title="管理中心" icon={<UserMenuIcon type="admin" />} titleId="admin-center-title" size="compact" mobile={mobile} mobileFitContent minimizable={false} bodyClassName="administration-center">
      {sections.map(section => <section key={section.title} className="user-menu__section">
        <h3 className="user-menu__section-label">{section.title}</h3>
        {section.items.map(item => {
          const external = 'href' in item;
          const content = <>
            <span className="user-menu__item-icon"><UserMenuIcon type={item.icon} /></span>
            <span className="min-w-0 flex-1">{item.label}</span>
            <MenuDestinationIcon external={external} />
          </>;
          const trackFeishu = () => {
            if (item.icon === 'feishu') featureAction('feishu_admin', 'open_feishu', 'user_menu');
          };
          return external
            ? <a key={item.icon} className="user-menu__item" href={item.href} target="_blank" rel="noopener noreferrer" onClick={trackFeishu} onAuxClick={event => { if (event.button === 1) trackFeishu(); }}>{content}<span className="sr-only">（新标签页打开）</span></a>
            : <button key={item.icon} type="button" className="user-menu__item" onClick={() => onSelect(item.panel)}>{content}</button>;
        })}
      </section>)}
    </PanelShell>
  );
}
