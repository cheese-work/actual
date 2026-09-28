import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type AcceptanceApi = {
  init(config: {
    dataDir: string;
    serverURL: string;
    password: string;
  }): Promise<unknown>;
  shutdown(): Promise<void>;
  runImport(name: string, func: () => Promise<void>): Promise<void>;
  createAccount(account: { name: string }, balance?: number): Promise<string>;
  getBudgets(): Promise<
    Array<{ id: string; groupId?: string; name: string; state?: string }>
  >;
  getAccounts(): Promise<Array<{ id: string; name: string }>>;
  downloadBudget(syncId: string): Promise<unknown>;
  sync(): Promise<unknown>;
};

type WindowWithApi = Window & { apiReady: Promise<AcceptanceApi> };

const SERVER_IMAGE = 'docker.io/actualbudget/actual-server:latest';
const containerName = `che838-actual-server-${process.pid}-${randomUUID()}`;
const serverPassword = randomUUID();
let containerId: string | undefined;
let serverURL = '';

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
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
      await api.init(config);
    },
    { dataDir, serverURL: url, password },
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

test('two authenticated clients sync one budget on upstream Actual Server', async ({
  browser,
}) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const firstPage = await firstContext.newPage();
  const secondPage = await secondContext.newPage();

  try {
    await startClient(firstPage, '/first-client', serverURL, serverPassword);
    const firstSyncId = await firstPage.evaluate(async () => {
      const api = await (window as unknown as WindowWithApi).apiReady;
      await api.runImport('CHE-838 upstream acceptance', async () => {
        await api.createAccount({ name: 'First client' }, 0);
      });

      const [budget] = await api.getBudgets();
      if (!budget?.groupId) {
        throw new Error('First client budget was not uploaded to the server');
      }
      return budget.groupId;
    });

    await startClient(secondPage, '/second-client', serverURL, serverPassword);
    await expect
      .poll(() =>
        secondPage.evaluate(async () =>
          (await (window as unknown as WindowWithApi).apiReady).getBudgets(),
        ),
      )
      .toContainEqual(
        expect.objectContaining({ groupId: firstSyncId, state: 'remote' }),
      );

    await secondPage.evaluate(async syncId => {
      const api = await (window as unknown as WindowWithApi).apiReady;
      await api.downloadBudget(syncId);
    }, firstSyncId);

    const secondClientBudgets = await secondPage.evaluate(async () =>
      (await (window as unknown as WindowWithApi).apiReady).getBudgets(),
    );
    expect(secondClientBudgets.map(budget => budget.groupId)).toContain(
      firstSyncId,
    );
    expect(
      (
        await secondPage.evaluate(async () =>
          (await (window as unknown as WindowWithApi).apiReady).getAccounts(),
        )
      ).map(account => account.name),
    ).toContain('First client');

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
    ).toEqual(expect.arrayContaining(['First client', 'Second client']));
  } finally {
    await Promise.allSettled(
      [firstPage, secondPage].map(async page => {
        if (!page.isClosed()) {
          await page.evaluate(async () =>
            (await (window as unknown as WindowWithApi).apiReady).shutdown(),
          );
        }
      }),
    );
    await Promise.all([firstContext.close(), secondContext.close()]);
  }
});
