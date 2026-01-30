/**
 * Integration specs for Connection using mock ServiceNow, real HealthChecker, and real model.
 * Require the mock server to be running on localhost:3099 (e.g. `node run.js`).
 * Run with: npm test (with mock server running)
 */

const http = require('http');
const { Connection } = require('../connection');
const { setModelProvider } = require('../providers.js');
const { PORT } = require('./support/check-mock-server.js');

const { ObservableModel } = require('model-manager/observable-model');

const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;

function getSessionCookieFromIndex() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        path: '/index.do',
        method: 'GET',
      },
      (res) => {
        const setCookie = res.headers['set-cookie'];
        if (!setCookie) {
          resolve(null);
          return;
        }
        const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
        const match = header.match(/glide_session_store=([^;]+)/);
        resolve(match ? `glide_session_store=${match[1].trim()}` : null);
      }
    );
    req.on('error', reject);
    req.setTimeout(2000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

describe('Connection (integration)', () => {
  let model;
  let connection;
  const id = 0;

  beforeAll(() => {
    model = new ObservableModel();
    setModelProvider({ getModel: () => model });
  });

  beforeEach(() => {
    if (model.reset) model.reset();
    model.set(`${id}_url`, BASE_URL);
    model.set(`${id}_validationInterval`, 10000);
    model.set(`${id}_conn_status`, 'off');
    if (connection) {
      connection.disconnect();
      connection = null;
    }
  });

  afterEach(() => {
    if (connection) {
      connection.disconnect();
      connection = null;
    }
  });

  describe('Method B: connect() with real health checker', () => {
    it('turns on when cookie is valid and health check passes (nav_to -> sys.scripts.do)', async () => {
      const cookie = await getSessionCookieFromIndex();
      expect(cookie).toBeTruthy();

      model.set(`${id}_browser_cookies`, { [HOST]: cookie });

      connection = new Connection({ id });
      const result = await connection.connect();

      expect(result).toBe(true);
      expect(model.get(`${id}_conn_status`)).toBe('on');
      expect(model.get(`${id}_conn_glide_session_store`)).toBeTruthy();
      expect(model.get(`${id}_last_activity`)).toBeTruthy();
      expect(typeof model.get(`${id}_last_activity`)).toBe('number');
    });

    it('fails immediately when no cookies for domain', async () => {
      model.set(`${id}_browser_cookies`, {});

      connection = new Connection({ id });
      const result = await connection.connect();

      expect(result).toBe(false);
      expect(model.get(`${id}_conn_status`)).toBe('off');
    });

    it('fails when cookie has no glide_session_store', async () => {
      model.set(`${id}_browser_cookies`, { [HOST]: 'other=value' });

      connection = new Connection({ id });
      const result = await connection.connect();

      expect(result).toBe(false);
      expect(model.get(`${id}_conn_status`)).toBe('off');
    });

    it('fails when cookie is invalid (session not in mock)', async () => {
      model.set(`${id}_browser_cookies`, { [HOST]: 'glide_session_store=invalid-session-id' });

      connection = new Connection({ id });
      const result = await connection.connect();

      expect(result).toBe(false);
      expect(model.get(`${id}_conn_status`)).toBe('off');
    });
  });

  describe('Method A: turn on via cookie change', () => {
    it('turns on when cookie with glide_session_store is set for domain', async () => {
      const cookie = await getSessionCookieFromIndex();
      expect(cookie).toBeTruthy();

      connection = new Connection({ id });
      model.set(`${id}_browser_cookies`, { [HOST]: cookie });

      await new Promise((r) => setImmediate(r));

      expect(model.get(`${id}_conn_status`)).toBe('on');
    });
  });

  describe('Method Q: disconnect()', () => {
    it('turns off when disconnect() is called after connect()', async () => {
      const cookie = await getSessionCookieFromIndex();
      model.set(`${id}_browser_cookies`, { [HOST]: cookie });

      connection = new Connection({ id });
      await connection.connect();
      expect(model.get(`${id}_conn_status`)).toBe('on');

      connection.disconnect();
      expect(model.get(`${id}_conn_status`)).toBe('off');
    });
  });
});
