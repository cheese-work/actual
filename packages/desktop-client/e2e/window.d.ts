import type { SyncedPrefs } from '@actual-app/core/types/prefs';

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- global Window augmentation requires interface
  interface Window {
    __accountsRequestHeld: boolean;
    __releaseAccountsRequests: () => void;
    $send: (method: string, args?: Record<string, unknown>) => Promise<unknown>;
    __TANSTACK_QUERY_CLIENT__: {
      getQueryState: (queryKey: string[]) =>
        | {
            data: unknown;
            fetchStatus: string;
            status: string;
          }
        | undefined;
    };
    __actionsForMenu: {
      saveSyncedPrefs: (payload: { prefs: SyncedPrefs }) => Promise<unknown>;
    };
  }
}
