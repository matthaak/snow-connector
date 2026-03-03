/**
 * Integration spec for the full login/logout lifecycle with real browser + mock server.
 * Requires mock server on localhost:3099 (run `node run` first).
 */

const http = require('http');
const { Connection } = require('../connection');
const {
  setModelProvider,
  setBrowserProvider,
  getBrowserProvider,
  setHealthCheckerFactory,
  createDefaultBrowserProvider,
} = require('../providers.js');
const { HealthChecker } = require('../healthChecker.js');
const { PORT } = require('./support/check-mock-server.js');
const { ObservableModel } = require('observable-state-model');

const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;

function buildHealthUrlForConnKey(connKey) {
  return `${BASE_URL}/nav_to.do?uri=${encodeURIComponent(`ws_blank_page.do?${connKey}`)}`;
}

describe('Connection (integration): managed/unmanaged lifecycle', () => {
  let model;
  let connection;
  let browserLaunchFailed = false;

  async function httpGet(url) {
    await new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', reject);
    });
  }

  async function closeAllPages() {
    const browser = getBrowserProvider().getBrowser();
    if (!browser || typeof browser.pages !== 'function') return;
    const pages = await browser.pages();
    for (const p of pages) {
      if (!p.isClosed()) await p.close().catch(() => {});
    }
  }

  async function clearDomainCookies() {
    const browser = getBrowserProvider().getBrowser();
    if (!browser || typeof browser.pages !== 'function') return;
    const pages = await browser.pages();
    for (const p of pages) {
      if (p.isClosed()) continue;
      try {
        const cookies = await p.cookies();
        const toDelete = cookies.filter((c) => c.domain && (c.domain === HOST || c.domain === `.${HOST}`));
        if (toDelete.length) await p.deleteCookie(...toDelete);
      } catch (_) {
        // ignore
      }
    }
  }

  async function waitForStatus(id, expected, timeoutMs = 5000) {
    const statusKey = `${id}_conn_status`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (model.get(statusKey) === expected) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for ${statusKey}=${expected}; actual=${model.get(statusKey)}`);
  }

  async function waitForConnKeyChange(id, previous, timeoutMs = 5000) {
    const keyName = `${id}_conn_key`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = model.get(keyName);
      if (typeof current === 'string' && current && current !== previous) {
        return current;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for ${keyName} to rotate`);
  }

  const skipIfNoBrowser = (fn) => function wrapped() {
    if (browserLaunchFailed) {
      pending('Browser not available');
      return;
    }
    return fn.apply(this, arguments);
  };

  beforeAll(async () => {
    model = new ObservableModel();
    setModelProvider({ getModel: () => model });
    setHealthCheckerFactory({ create: (cid) => new HealthChecker(cid) });
    setBrowserProvider(createDefaultBrowserProvider());

    try {
      const provider = getBrowserProvider();
      await provider.launch({ headless: true });
    } catch (err) {
      browserLaunchFailed = true;
      console.warn('Connection integration tests skipped: browser launch failed', err.message);
    }
  }, 60000);

  beforeEach(async () => {
    if (connection) {
      connection.disconnect();
      connection = null;
    }
    if (browserLaunchFailed) return;
    await httpGet(`${BASE_URL}/test/invalidate-session`);
    await closeAllPages();
    await clearDomainCookies();
    model.reset();
    setModelProvider({ getModel: () => model });
  });

  afterEach(() => {
    if (connection) {
      connection.disconnect();
      connection = null;
    }
  });

  afterAll(async () => {
    const browser = getBrowserProvider().getBrowser();
    if (browser && browser.close) await browser.close().catch(() => {});
  });

  it('covers managed login/logout, unmanaged login, connect/disconnect/connect flow', skipIfNoBrowser(async () => {
    connection = new Connection({ instanceUrl: BASE_URL, validationInterval: 1000 });

    // CONNECT -> off (health path does not succeed without login)
    const firstConnect = await connection.connect();
    expect(firstConnect).toBe(false);
    expect(connection.isOn()).toBe(false);
    expect(model.get(`${connection.id}_conn_status`)).toBe('off');
    expect(connection.workerPage).toBeTruthy();
    expect(connection.workerPage.isClosed()).toBe(false);
    const firstConnKey = model.get(`${connection.id}_conn_key`);
    expect(typeof firstConnKey).toBe('string');
    expect(firstConnKey.length).toBeGreaterThan(0);

    // DO MANAGED LOGIN -> on
    await connection.workerPage.goto(`${BASE_URL}/index.do`, { waitUntil: 'load', timeout: 10000 });
    await connection.workerPage.goto(buildHealthUrlForConnKey(firstConnKey), { waitUntil: 'load', timeout: 10000 });
    await waitForStatus(connection.id, 'on');
    expect(connection.isOn()).toBe(true);
    const secondConnKey = await waitForConnKeyChange(connection.id, firstConnKey);

    // DO MANAGED LOGOUT -> off
    await connection.workerPage.goto(`${BASE_URL}/logout.do`, { waitUntil: 'load', timeout: 10000 });
    await waitForStatus(connection.id, 'off', 7000);
    expect(connection.isOn()).toBe(false);

    // DO UNMANAGED LOGIN -> still off
    const browser = getBrowserProvider().getBrowser();
    const unmanagedPage = await browser.newPage();
    await unmanagedPage.goto(`${BASE_URL}/index.do`, { waitUntil: 'load', timeout: 10000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(connection.isOn()).toBe(false);
    expect(model.get(`${connection.id}_conn_status`)).toBe('off');

    // OUT-OF-BAND stale-key success URL while off -> stays off
    await unmanagedPage.goto(buildHealthUrlForConnKey(firstConnKey), { waitUntil: 'load', timeout: 10000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(connection.isOn()).toBe(false);
    expect(model.get(`${connection.id}_conn_status`)).toBe('off');
    expect(model.get(`${connection.id}_conn_key`)).toBe(secondConnKey);

    // CONNECT -> on (managed tab loads success path with existing session)
    const secondConnect = await connection.connect();
    expect(secondConnect).toBe(true);
    await waitForStatus(connection.id, 'on');
    expect(connection.isOn()).toBe(true);

    // DISCONNECT -> off (session remains in browser)
    connection.disconnect();
    await waitForStatus(connection.id, 'off');
    expect(connection.isOn()).toBe(false);

    // CONNECT again -> on (same session, no new login)
    const thirdConnect = await connection.connect();
    expect(thirdConnect).toBe(true);
    await waitForStatus(connection.id, 'on');
    expect(connection.isOn()).toBe(true);
  }), 120000);
});
