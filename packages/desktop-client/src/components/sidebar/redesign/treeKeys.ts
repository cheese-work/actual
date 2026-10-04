import type { Key } from 'react-aria-components';

export type SidebarTreeKey =
  | `account:${string}`
  | `group:${string}`
  | `rounding-adjustment:${string}`;

export type SidebarTreeNode =
  | { kind: 'account'; accountId: string }
  | { kind: 'group'; groupId: string }
  | { kind: 'adjustment'; groupId: string };

export const treeKeys = {
  account(accountId: string): SidebarTreeKey {
    return `account:${accountId}`;
  },
  group(groupId: string): SidebarTreeKey {
    return `group:${groupId}`;
  },
  adjustment(groupId: string): SidebarTreeKey {
    return `rounding-adjustment:${groupId}`;
  },
};

export function parseTreeKey(key: Key): SidebarTreeNode | null {
  if (typeof key !== 'string') {
    return null;
  }
  if (key.startsWith('account:')) {
    return { kind: 'account', accountId: key.slice('account:'.length) };
  }
  if (key.startsWith('group:')) {
    return { kind: 'group', groupId: key.slice('group:'.length) };
  }
  if (key.startsWith('rounding-adjustment:')) {
    return {
      kind: 'adjustment',
      groupId: key.slice('rounding-adjustment:'.length),
    };
  }
  return null;
}
