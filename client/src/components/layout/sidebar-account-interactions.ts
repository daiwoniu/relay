import type { SidebarAccountScope } from './sidebar-account-filter';

type ResourceOwner = {
  id: string;
  displayName: string;
};

export function getSidebarAccountInteractionPolicy(
  scope: SidebarAccountScope,
  currentUserId: string,
  owner?: ResourceOwner | null,
) {
  const viewingAllAccounts = scope === 'all';
  const editingAnotherAccount = viewingAllAccounts && Boolean(owner && owner.id !== currentUserId);

  return {
    showOwner: viewingAllAccounts,
    canOrganize: !viewingAllAccounts,
    renameLabel: editingAnotherAccount ? `重命名 · ${owner!.displayName}` : '重命名',
  };
}
