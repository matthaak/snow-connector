const { Connection } = require('../connection');
const { getModelProvider, setBrowserProvider, setHealthCheckerFactory } = require('../providers.js');

describe('Connection scenario semantics', () => {
  let model;
  let connection;
  let healthChecker;
  let browser;
  let pages;
  let fetchImpl;
  const baseUrl = 'https://testdummy.service-now.com';

  function createPage(initialUrl = `${baseUrl}/index.do`) {
    let pageUrl = initialUrl;
    let cookieList = [];
    const loadListeners = [];
    const page = {
      isClosed: () => false,
      on: jasmine.createSpy('on').and.callFake((event, handler) => {
        if (event === 'load') loadListeners.push(handler);
      }),
      url: jasmine.createSpy('url').and.callFake(() => pageUrl),
      goto: jasmine.createSpy('goto').and.callFake(async (nextUrl) => {
        pageUrl = nextUrl;
        for (const handler of loadListeners) {
          await Promise.resolve(handler());
        }
      }),
      evaluate: jasmine.createSpy('evaluate').and.callFake(async (fn, args) => {
        // fetch path
        if (args && args.url) {
          return fetchImpl(args.url);
        }
        // g_ck sync path
        return 'gck-token-1';
      }),
      cookies: jasmine.createSpy('cookies').and.callFake(async () => cookieList),
    };
    page.__setCookies = (nextCookies) => {
      cookieList = nextCookies;
    };
    return page;
  }

  beforeEach(() => {
    model = getModelProvider().getModel();
    model.reset();

    pages = [];
    fetchImpl = async (url) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {},
      body: '',
      finalUrl: url,
    });

    browser = {
      isConnected: () => true,
      pages: jasmine.createSpy('pages').and.callFake(async () => pages),
      newPage: jasmine.createSpy('newPage').and.callFake(async () => {
        const page = createPage();
        pages.push(page);
        return page;
      }),
      on: jasmine.createSpy('on'),
    };

    healthChecker = {
      startPeriodicCheck: jasmine.createSpy('startPeriodicCheck'),
      stopPeriodicCheck: jasmine.createSpy('stopPeriodicCheck').and.returnValue(Promise.resolve()),
      setCheckProvider: jasmine.createSpy('setCheckProvider'),
      ensureConnKey: jasmine.createSpy('ensureConnKey').and.callFake(() => {
        if (connection) {
          const key = model.get(`${connection.id}_conn_key`);
          if (typeof key === 'string' && key) return key;
          model.set(`${connection.id}_conn_key`, 'conn-key-1');
          return 'conn-key-1';
        }
        return 'conn-key-1';
      }),
      rotateConnKey: jasmine.createSpy('rotateConnKey').and.callFake(() => {
        const keyName = `${connection.id}_conn_key`;
        const next = model.get(keyName) === 'conn-key-1' ? 'conn-key-2' : 'conn-key-1';
        model.set(keyName, next);
        return next;
      }),
    };

    setBrowserProvider({ getBrowser: () => browser });
    setHealthCheckerFactory({ create: () => healthChecker });
  });

  afterEach(() => {
    if (connection) {
      connection.disconnect();
      connection = null;
    }
  });

  it('initializes connection model keys', () => {
    connection = new Connection({ instanceUrl: baseUrl, validationInterval: 1000 });
    expect(model.get(`${connection.id}_conn_status`)).toBe('off');
    expect(model.get(`${connection.id}_url`)).toBe(baseUrl);
    expect(typeof model.get(`${connection.id}_conn_key`)).toBe('string');
    expect(model.get(`${connection.id}_glide_session_store`)).toBeNull();
  });

  it('connect marks ON and rotates key when fetch reaches success suffix', async () => {
    connection = new Connection({ instanceUrl: baseUrl, validationInterval: 1000 });
    const key = model.get(`${connection.id}_conn_key`);
    const fetchPage = createPage(`${baseUrl}/index.do`);
    pages.push(fetchPage);
    fetchImpl = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {},
      body: '',
      finalUrl: `${baseUrl}/ws_blank_page.do?${key}`,
    });

    const ok = await connection.connect();
    expect(ok).toBe(true);
    expect(connection.isOn()).toBe(true);
    expect(model.get(`${connection.id}_conn_key`)).not.toBe(key);
  });

  it('connect keeps OFF and preserves key when no fetchable tab and nav lands off-suffix', async () => {
    connection = new Connection({ instanceUrl: baseUrl, validationInterval: 1000 });
    const rotateCountBefore = healthChecker.rotateConnKey.calls.count();
    const navPage = createPage(`${baseUrl}/index.do`);
    navPage.goto.and.callFake(async () => {
      // off-suffix landing
      navPage.url.and.returnValue(`${baseUrl}/logout.do`);
    });
    browser.newPage.and.returnValue(Promise.resolve(navPage));

    const ok = await connection.connect();
    expect(ok).toBe(false);
    expect(connection.isOn()).toBe(false);
    expect(healthChecker.rotateConnKey.calls.count()).toBe(rotateCountBefore);
  });

  it('health check marks OFF and rotates key on fetch failure', async () => {
    connection = new Connection({ instanceUrl: baseUrl, validationInterval: 1000 });
    model.set(`${connection.id}_conn_status`, 'on');
    const fetchPage = createPage(`${baseUrl}/index.do`);
    pages.push(fetchPage);
    fetchImpl = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {},
      body: '',
      finalUrl: `${baseUrl}/logout.do`,
    });

    await connection._runHealthScenario();
    expect(connection.isOn()).toBe(false);
    expect(healthChecker.rotateConnKey).toHaveBeenCalled();
  });

  it('consumer fetch with no fetchable tab nav off-suffix marks OFF, rotates key, and throws', async () => {
    connection = new Connection({ instanceUrl: baseUrl, validationInterval: 1000 });
    model.set(`${connection.id}_conn_status`, 'on');
    const key = model.get(`${connection.id}_conn_key`);
    model.set('browser_g_cks', { 'testdummy.service-now.com': 'token-123' });
    const navPage = createPage(`${baseUrl}/index.do`);
    navPage.goto.and.callFake(async () => {
      navPage.url.and.returnValue(`${baseUrl}/logout.do`);
    });
    browser.newPage.and.returnValue(Promise.resolve(navPage));

    let threw = false;
    try {
      await connection.fetch('/api/now/table/incident');
    } catch (e) {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(connection.isOn()).toBe(false);
    expect(model.get(`${connection.id}_conn_key`)).not.toBe(key);
  });

  it('fetch rejects absolute URLs', async () => {
    connection = new Connection({ instanceUrl: baseUrl, validationInterval: 1000 });
    model.set(`${connection.id}_conn_status`, 'on');
    model.set('browser_g_cks', { 'testdummy.service-now.com': 'token-123' });
    const page = createPage(`${baseUrl}/index.do`);
    pages.push(page);

    let threw = false;
    try {
      await connection.fetch('https://example.com/api');
    } catch (e) {
      threw = true;
      expect(String(e.message)).toContain('relative');
    }
    expect(threw).toBe(true);
  });

  it('fetch injects X-UserToken from model when caller does not provide it', async () => {
    connection = new Connection({ instanceUrl: baseUrl, validationInterval: 1000 });
    model.set(`${connection.id}_conn_status`, 'on');
    model.set('browser_g_cks', { 'testdummy.service-now.com': 'token-123' });
    const page = createPage(`${baseUrl}/index.do`);
    pages.push(page);

    let capturedUrl = null;
    let capturedHeaders = null;
    fetchImpl = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {},
        body: '',
        finalUrl: url,
      };
    };
    page.evaluate.and.callFake(async (fn, args) => {
      if (args && args.url) {
        capturedHeaders = args.init && args.init.headers;
        return fetchImpl(args.url);
      }
      return 'token-123';
    });

    await connection.fetch('api/now/table/incident');
    expect(capturedUrl).toBe(`${baseUrl}/api/now/table/incident`);
    expect(capturedHeaders['X-UserToken']).toBe('token-123');
  });

  it('disconnect marks OFF and rotates key', () => {
    connection = new Connection({ instanceUrl: baseUrl, validationInterval: 1000 });
    model.set(`${connection.id}_conn_status`, 'on');
    const key = model.get(`${connection.id}_conn_key`);
    connection.disconnect();
    expect(connection.isOn()).toBe(false);
    expect(model.get(`${connection.id}_conn_key`)).not.toBe(key);
  });

  it('updates glide_session_store value and triggers health check on value change while ON', async () => {
    connection = new Connection({ instanceUrl: baseUrl, validationInterval: 1000 });
    model.set(`${connection.id}_conn_status`, 'on');
    const page = createPage(`${baseUrl}/index.do`);
    page.__setCookies([{ name: 'glide_session_store', value: 'abc' }]);

    await connection._syncGlideSessionStore(page);
    expect(model.get(`${connection.id}_glide_session_store`)).toBe('abc');

    const triggerSpy = spyOn(connection, '_triggerHealthCheckFromCookieChange').and.callFake(() => {});
    page.__setCookies([{ name: 'glide_session_store', value: 'xyz' }]);
    await connection._syncGlideSessionStore(page);

    expect(model.get(`${connection.id}_glide_session_store`)).toBe('xyz');
    expect(triggerSpy).toHaveBeenCalled();
  });
});
