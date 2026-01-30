/**
 * Integration specs for Mock ServiceNow.
 * Require the mock server to be running on localhost:3099 (e.g. `node run.js`).
 * Uses real HTTP requests. Run with: npm test
 */

const http = require('http');
require('./support/check-mock-server.js');

const BASE_URL = 'http://localhost:3099';

function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: 5000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

function parseSetCookie(header) {
  if (!header) return {};
  const parts = (Array.isArray(header) ? header.join('; ') : header).split(',').map((s) => s.trim());
  const result = {};
  for (const part of parts) {
    const [nameVal, ...attrs] = part.split(';').map((s) => s.trim());
    const eq = nameVal.indexOf('=');
    if (eq === -1) continue;
    const name = nameVal.slice(0, eq);
    const value = nameVal.slice(eq + 1);
    result[name] = { value, httpOnly: attrs.some((a) => a.toLowerCase() === 'httponly') };
  }
  return result;
}

function cookieHeaderFromResponse(res) {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return null;
  const cookies = parseSetCookie(Array.isArray(setCookie) ? setCookie[0] : setCookie);
  const session = cookies.glide_session_store;
  return session ? `glide_session_store=${session.value}` : null;
}

describe('Mock ServiceNow (integration)', () => {
  describe('GET /index.do', () => {
    it('returns 200 and sets glide_session_store cookie with HttpOnly', async () => {
      const res = await httpGet(`${BASE_URL}/index.do`);
      expect(res.statusCode).toBe(200);
      const cookies = parseSetCookie(res.headers['set-cookie']);
      expect(cookies.glide_session_store).toBeDefined();
      expect(cookies.glide_session_store.value).toBeTruthy();
      expect(cookies.glide_session_store.httpOnly).toBe(true);
    });

    it('body contains Welcome to the mock instance, glide_session_store, and g_ck', async () => {
      const res = await httpGet(`${BASE_URL}/index.do`);
      expect(res.body).toContain('Welcome to the mock instance!');
      expect(res.body).toContain('glide_session_store:');
      expect(res.body).toContain('g_ck:');
    });

    it('sets a new window.g_ck in script on each request', async () => {
      const res1 = await httpGet(`${BASE_URL}/index.do`);
      const res2 = await httpGet(`${BASE_URL}/index.do`);
      const match1 = res1.body.match(/window\.g_ck\s*=\s*'([^']+)'/);
      const match2 = res2.body.match(/window\.g_ck\s*=\s*'([^']+)'/);
      expect(match1).toBeTruthy();
      expect(match2).toBeTruthy();
      expect(match1[1]).not.toBe(match2[1]);
    });

    it('body g_ck value matches value in script', async () => {
      const res = await httpGet(`${BASE_URL}/index.do`);
      const scriptMatch = res.body.match(/window\.g_ck\s*=\s*'([^']+)'/);
      const bodyMatch = res.body.match(/g_ck:\s*([^\s<]+)/);
      expect(scriptMatch).toBeTruthy();
      expect(bodyMatch).toBeTruthy();
      expect(bodyMatch[1]).toBe(scriptMatch[1]);
    });
  });

  describe('GET /logout.do', () => {
    it('returns 200 and does not set glide_session_store cookie', async () => {
      const res = await httpGet(`${BASE_URL}/logout.do`);
      expect(res.statusCode).toBe(200);
      const setCookie = res.headers['set-cookie'];
      if (setCookie) {
        const cookies = parseSetCookie(Array.isArray(setCookie) ? setCookie.join('; ') : setCookie);
        expect(cookies.glide_session_store).toBeUndefined();
      }
    });

    it('body contains Logged out and has no g_ck script', async () => {
      const res = await httpGet(`${BASE_URL}/logout.do`);
      expect(res.body).toContain('Logged out.');
      expect(res.body).not.toContain('window.g_ck');
    });

    it('after logout, index.do creates a new session', async () => {
      const indexRes = await httpGet(`${BASE_URL}/index.do`);
      const cookies1 = parseSetCookie(
        Array.isArray(indexRes.headers['set-cookie']) ? indexRes.headers['set-cookie'][0] : indexRes.headers['set-cookie']
      );
      const firstSession = cookies1.glide_session_store.value;

      await httpGet(`${BASE_URL}/logout.do`);

      const indexRes2 = await httpGet(`${BASE_URL}/index.do`);
      const cookies2 = parseSetCookie(
        Array.isArray(indexRes2.headers['set-cookie']) ? indexRes2.headers['set-cookie'][0] : indexRes2.headers['set-cookie']
      );
      const secondSession = cookies2.glide_session_store.value;
      expect(secondSession).toBeTruthy();
      expect(secondSession).not.toBe(firstSession);
    });
  });

  describe('GET /nav_to.do', () => {
    it('without cookie redirects to /logout.do', async () => {
      const res = await httpGet(`${BASE_URL}/nav_to.do?uri=sys.scripts.do`);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/logout.do');
    });

    it('with invalid cookie redirects to /logout.do', async () => {
      const res = await httpGet(`${BASE_URL}/nav_to.do?uri=sys.scripts.do`, {
        headers: { Cookie: 'glide_session_store=wrong-value' },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/logout.do');
    });

    it('with valid cookie redirects to requested uri', async () => {
      const indexRes = await httpGet(`${BASE_URL}/index.do`);
      const cookieHeader = cookieHeaderFromResponse(indexRes);
      expect(cookieHeader).toBeTruthy();

      const res = await httpGet(`${BASE_URL}/nav_to.do?uri=sys.scripts.do`, {
        headers: { Cookie: cookieHeader },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/sys.scripts.do');
    });

    it('with valid cookie and uri with leading slash redirects to that path', async () => {
      const indexRes = await httpGet(`${BASE_URL}/index.do`);
      const cookieHeader = cookieHeaderFromResponse(indexRes);

      const res = await httpGet(`${BASE_URL}/nav_to.do?uri=/foo/bar.do`, {
        headers: { Cookie: cookieHeader },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/foo/bar.do');
    });
  });

  describe('GET wildcard (e.g. /sys.scripts.do)', () => {
    it('without cookie redirects to /logout.do', async () => {
      const res = await httpGet(`${BASE_URL}/sys.scripts.do`);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/logout.do');
    });

    it('with invalid cookie redirects to /logout.do', async () => {
      const res = await httpGet(`${BASE_URL}/sys.scripts.do`, {
        headers: { Cookie: 'glide_session_store=invalid' },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/logout.do');
    });

    it('with valid cookie returns 200 and page with Welcome to [uri] and g_ck', async () => {
      const indexRes = await httpGet(`${BASE_URL}/index.do`);
      const cookieHeader = cookieHeaderFromResponse(indexRes);

      const res = await httpGet(`${BASE_URL}/sys.scripts.do`, {
        headers: { Cookie: cookieHeader },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Welcome to sys.scripts.do');
      expect(res.body).toContain('g_ck:');
      expect(res.body).toMatch(/window\.g_ck\s*=\s*'[^']+'/);
    });

    it('body g_ck value matches value in script', async () => {
      const indexRes = await httpGet(`${BASE_URL}/index.do`);
      const cookieHeader = cookieHeaderFromResponse(indexRes);

      const res = await httpGet(`${BASE_URL}/some.module.do`, {
        headers: { Cookie: cookieHeader },
      });
      const scriptMatch = res.body.match(/window\.g_ck\s*=\s*'([^']+)'/);
      const bodyMatch = res.body.match(/g_ck:\s*([^\s<]+)/);
      expect(scriptMatch).toBeTruthy();
      expect(bodyMatch).toBeTruthy();
      expect(bodyMatch[1]).toBe(scriptMatch[1]);
    });

    it('nav_to then wildcard: valid session serves wildcard page', async () => {
      const indexRes = await httpGet(`${BASE_URL}/index.do`);
      const cookieHeader = cookieHeaderFromResponse(indexRes);

      const navRes = await httpGet(`${BASE_URL}/nav_to.do?uri=sys.scripts.do`, {
        headers: { Cookie: cookieHeader },
      });
      expect(navRes.statusCode).toBe(302);
      expect(navRes.headers.location).toBe('/sys.scripts.do');

      const wildcardRes = await httpGet(`${BASE_URL}/sys.scripts.do`, {
        headers: { Cookie: cookieHeader },
      });
      expect(wildcardRes.statusCode).toBe(200);
      expect(wildcardRes.body).toContain('Welcome to sys.scripts.do');
    });
  });

  describe('other paths', () => {
    it('POST returns 404', async () => {
      const res = await new Promise((resolve, reject) => {
        const parsed = new URL(`${BASE_URL}/index.do`);
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: 'POST',
            timeout: 5000,
          },
          (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () =>
              resolve({
                statusCode: res.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
              })
            );
          }
        );
        req.on('error', reject);
        req.end();
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe('Not Found');
    });
  });
});
