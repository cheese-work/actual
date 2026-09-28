import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import Database from 'better-sqlite3';

type AcceptanceApi = {
  init(config: {
    dataDir: string;
    serverURL: string;
    password: string;
  }): Promise<{ send: CoreSend }>;
  shutdown(): Promise<void>;
  runImport(name: string, func: () => Promise<void>): Promise<void>;
  createAccount(account: { name: string }, balance?: number): Promise<string>;
  getBudgets(): Promise<
    Array<{ id: string; groupId?: string; name: string; state?: string }>
  >;
  getAccounts(): Promise<Array<{ id: string; name: string }>>;
  getPreferences(): Promise<{
    budgetCurrencyCode?: string;
    currencySetupFinalized?: string;
  }>;
  downloadBudget(syncId: string): Promise<unknown>;
  sync(): Promise<unknown>;
};

type CoreSend = (name: string, args?: unknown) => Promise<unknown>;

type WindowWithApi = Window & {
  apiReady: Promise<AcceptanceApi>;
  coreSend?: CoreSend;
};

const SERVER_IMAGE = 'docker.io/actualbudget/actual-server:latest';
const BUNDLED_DATABASE_PATH = path.resolve(
  __dirname,
  '../../loot-core/default-db.sqlite',
);
const containerName = `che838-actual-server-${process.pid}-${randomUUID()}`;
const serverPassword = randomUUID();
let containerId: string | undefined;
let serverURL = '';

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

function assertBundledDatabaseIsPreCurrencySchema(): void {
  const database = new Database(BUNDLED_DATABASE_PATH, { readonly: true });

  try {
    const migrations = database
      .prepare('SELECT id FROM __migrations__')
      .all() as Array<{ id: number }>;
    expect(migrations.map(({ id }) => id)).not.toContain(1790000000000);

    const accountColumns = database.pragma('table_info(accounts)') as Array<{
      name: string;
    }>;
    expect(accountColumns.map(({ name }) => name)).not.toContain('currency');
  } finally {
    database.close();
  }
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError = 'health endpoint did not become ready';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok && (await response.json()).status === 'UP') {
        return;
      }
      lastError = `health endpoint returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error(`Actual server did not become healthy: ${lastError}`);
}

async function startClient(
  page: Page,
  dataDir: string,
  url: string,
  password: string,
): Promise<void> {
  await page.goto('/e2e/harness.html');
  await page.evaluate(
    async config => {
      const api = await (window as unknown as WindowWithApi).apiReady;
      const { send } = await api.init(config);
      (window as unknown as WindowWithApi).coreSend = send;
    },
    { dataDir, serverURL: url, password },
  );
}

async function waitForRemoteBudget(page: Page, syncId: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await (window as unknown as WindowWithApi).apiReady).getBudgets(),
      ),
    )
    .toContainEqual(
      expect.objectContaining({ groupId: syncId, state: 'remote' }),
    );
}

async function expectUnsetCurrencySetup(page: Page): Promise<void> {
  const state = await page.evaluate(async () => {
    const windowWithApi = window as unknown as WindowWithApi;
    const api = await windowWithApi.apiReady;
    if (!windowWithApi.coreSend) {
      throw new Error('Client core API is not initialized');
    }

    const accounts = (await windowWithApi.coreSend('accounts-get')) as Array<{
      currency?: string | null;
    }>;

    return {
      preferences: await api.getPreferences(),
      accountCurrencies: accounts.map(({ currency }) => currency),
    };
  });

  expect(state.preferences.currencySetupFinalized).toBeUndefined();
  expect(state.preferences.budgetCurrencyCode).toBeUndefined();
  expect(state.accountCurrencies.length).toBeGreaterThan(0);
  expect(state.accountCurrencies.every(currency => currency === null)).toBe(
    true,
  );
}

test.beforeAll(async () => {
  containerId = docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '--publish',
    '127.0.0.1::5006',
    SERVER_IMAGE,
  ]);

  const portMapping = docker(['port', containerName, '5006/tcp']);
  const hostPort = Number(portMapping.match(/:(\d+)$/)?.[1]);
  if (!Number.isInteger(hostPort)) {
    throw new Error(`Could not determine mapped server port: ${portMapping}`);
  }

  serverURL = `http://127.0.0.1:${hostPort}`;
  await waitForServer(serverURL);

  const bootstrap = await fetch(`${serverURL}/account/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: serverPassword }),
  });
  if (!bootstrap.ok) {
    throw new Error(
      `Could not bootstrap throwaway server: ${bootstrap.status} ${await bootstrap.text()}`,
    );
  }

  console.info(
    `Acceptance server image ${SERVER_IMAGE} (${docker([
      'inspect',
      '--format',
      '{{.Image}}',
      containerId,
    ])}) at ${serverURL}`,
  );
});

test.afterAll(() => {
  if (!containerId) {
    return;
  }

  const existingId = docker([
    'container',
    'ls',
    '--all',
    '--quiet',
    '--filter',
    `id=${containerId}`,
  ]);
  if (existingId) {
    docker(['container', 'rm', '--force', existingId]);
  }

  expect(
    docker([
      'container',
      'ls',
      '--all',
      '--quiet',
      '--filter',
      `id=${containerId}`,
    ]),
  ).toBe('');
});

test('two independent clients download a legacy budget from upstream Actual Server', async ({
  browser,
}) => {
  const contexts = [];
  const pages: Page[] = [];

  try {
    assertBundledDatabaseIsPreCurrencySchema();

    const seedContext = await browser.newContext();
    contexts.push(seedContext);
    const seedPage = await seedContext.newPage();
    pages.push(seedPage);
    const firstContext = await browser.newContext();
    contexts.push(firstContext);
    const firstPage = await firstContext.newPage();
    pages.push(firstPage);
    const secondContext = await browser.newContext();
    contexts.push(secondContext);
    const secondPage = await secondContext.newPage();
    pages.push(secondPage);

    await startClient(seedPage, '/seed-client', serverURL, serverPassword);
    const syncId = await seedPage.evaluate(async () => {
      const api = await (window as unknown as WindowWithApi).apiReady;
      await api.runImport('CHE-838 legacy pre-finalization seed', async () => {
        await api.createAccount({ name: 'Legacy seed account' }, 0);
      });

      const [budget] = await api.getBudgets();
      if (!budget?.groupId) {
        throw new Error('Legacy budget was not uploaded to the server');
      }
      return budget.groupId;
    });
    await expectUnsetCurrencySetup(seedPage);
    await seedPage.evaluate(async () =>
      (await (window as unknown as WindowWithApi).apiReady).shutdown(),
    );

    await startClient(firstPage, '/first-client', serverURL, serverPassword);
    await startClient(secondPage, '/second-client', serverURL, serverPassword);
    await Promise.all([
      waitForRemoteBudget(firstPage, syncId),
      waitForRemoteBudget(secondPage, syncId),
    ]);

    await firstPage.evaluate(async remoteSyncId => {
      const api = await (window as unknown as WindowWithApi).apiReady;
      await api.downloadBudget(remoteSyncId);
    }, syncId);
    await expectUnsetCurrencySetup(firstPage);
    await secondPage.evaluate(async remoteSyncId => {
      const api = await (window as unknown as WindowWithApi).apiReady;
      await api.downloadBudget(remoteSyncId);
    }, syncId);

    const secondClientBudgets = await secondPage.evaluate(async () =>
      (await (window as unknown as WindowWithApi).apiReady).getBudgets(),
    );
    expect(secondClientBudgets.map(budget => budget.groupId)).toContain(syncId);
    expect(
      (
        await secondPage.evaluate(async () =>
          (await (window as unknown as WindowWithApi).apiReady).getAccounts(),
        )
      ).map(account => account.name),
    ).toContain('Legacy seed account');

    await expectUnsetCurrencySetup(secondPage);

    await secondPage.evaluate(async () => {
      const api = await (window as unknown as WindowWithApi).apiReady;
      await api.createAccount({ name: 'Second client' }, 0);
      await api.sync();
    });
    await firstPage.evaluate(async () =>
      (await (window as unknown as WindowWithApi).apiReady).sync(),
    );

    expect(
      (
        await firstPage.evaluate(async () =>
          (await (window as unknown as WindowWithApi).apiReady).getAccounts(),
        )
      ).map(account => account.name),
    ).toEqual(expect.arrayContaining(['Legacy seed account', 'Second client']));
  } finally {
    await Promise.allSettled(
      pages.map(async page => {
        if (!page.isClosed()) {
          await page.evaluate(async () =>
            (await (window as unknown as WindowWithApi).apiReady).shutdown(),
          );
        }
      }),
    );
    await Promise.allSettled(contexts.map(context => context.close()));
  }
});
