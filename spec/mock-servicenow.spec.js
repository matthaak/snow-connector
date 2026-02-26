const { ObservableModel } = require('model-manager');
const {
  createMockServer,
  handleRequest,
  getOrCreateSessionStore,
  getGlideSessionStoreFromCookie,
  isSessionValid,
} = require('../mock-servicenow');

function createMockReq({ url = '/', method = 'GET', headers = {} } = {}) {
  return {
    url,
    method,
    headers: { host: 'localhost', ...headers },
  };
}

function createMockRes() {
  const res = {
    _statusCode: null,
    _headers: null,
    _body: null,
    writeHead(statusCode, headersOrMsg, maybeHeaders) {
      this._statusCode = statusCode;
      const headers = typeof headersOrMsg === 'object' ? headersOrMsg : maybeHeaders || {};
      this._headers = {};
      for (const [k, v] of Object.entries(headers)) {
        this._headers[k.toLowerCase()] = v;
      }
    },
    end(body) {
      this._body = body != null ? body : '';
    },
  };
  return res;
}

function simulateRequest(model, reqOptions) {
  const req = createMockReq(reqOptions);
  const res = createMockRes();
  handleRequest(model, req, res);
  return res;
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

describe('Mock ServiceNow', () => {
  let model;

  beforeEach(() => {
    model = new ObservableModel();
    model.set('mock_glide_session_store', null);
  });

  describe('handleRequest', () => {
    describe('GET /index.do', () => {
      it('returns 200 and sets glide_session_store cookie with HttpOnly', () => {
        const res = simulateRequest(model, { url: '/index.do' });
        expect(res._statusCode).toBe(200);
        const cookies = parseSetCookie(res._headers['set-cookie']);
        expect(cookies.glide_session_store).toBeDefined();
        expect(cookies.glide_session_store.value).toBeTruthy();
        expect(cookies.glide_session_store.httpOnly).toBe(true);
      });

      it('stores session in model when none exists and cookie matches', () => {
        const res = simulateRequest(model, { url: '/index.do' });
        expect(res._statusCode).toBe(200);
        const cookies = parseSetCookie(res._headers['set-cookie']);
        const cookieValue = cookies.glide_session_store.value;
        expect(model.get('mock_glide_session_store')).toBe(cookieValue);
      });

      it('uses existing model session when set', () => {
        const existing = 'existing-session-guid-12345';
        model.set('mock_glide_session_store', existing);
        const res = simulateRequest(model, { url: '/index.do' });
        expect(res._statusCode).toBe(200);
        const cookies = parseSetCookie(res._headers['set-cookie']);
        expect(cookies.glide_session_store.value).toBe(existing);
        expect(model.get('mock_glide_session_store')).toBe(existing);
      });

      it('body contains Welcome to the mock instance, glide_session_store, and g_ck', () => {
        const res = simulateRequest(model, { url: '/index.do' });
        expect(res._body).toContain('Welcome to the mock instance!');
        expect(res._body).toContain('glide_session_store:');
        expect(res._body).toContain('g_ck:');
        const sessionStore = model.get('mock_glide_session_store');
        expect(res._body).toContain(sessionStore);
      });

      it('sets a new window.g_ck in script on each request', () => {
        const res1 = simulateRequest(model, { url: '/index.do' });
        const res2 = simulateRequest(model, { url: '/index.do' });
        const match1 = res1._body.match(/window\.g_ck\s*=\s*'([^']+)'/);
        const match2 = res2._body.match(/window\.g_ck\s*=\s*'([^']+)'/);
        expect(match1).toBeTruthy();
        expect(match2).toBeTruthy();
        expect(match1[1]).not.toBe(match2[1]);
      });

      it('body g_ck value matches value in script', () => {
        const res = simulateRequest(model, { url: '/index.do' });
        const scriptMatch = res._body.match(/window\.g_ck\s*=\s*'([^']+)'/);
        const bodyMatch = res._body.match(/g_ck:\s*([^\s<]+)/);
        expect(scriptMatch).toBeTruthy();
        expect(bodyMatch).toBeTruthy();
        expect(bodyMatch[1]).toBe(scriptMatch[1]);
      });
    });

    describe('GET /logout.do', () => {
      it('returns 200 and does not set glide_session_store cookie', () => {
        const res = simulateRequest(model, { url: '/logout.do' });
        expect(res._statusCode).toBe(200);
        const setCookie = res._headers['set-cookie'];
        if (setCookie) {
          const cookies = parseSetCookie(setCookie);
          expect(cookies.glide_session_store).toBeUndefined();
        }
      });

      it('body contains Logged out and has no g_ck script', () => {
        const res = simulateRequest(model, { url: '/logout.do' });
        expect(res._body).toContain('Logged out.');
        expect(res._body).not.toContain('window.g_ck');
      });

      it('sets mock_glide_session_store to null in model', () => {
        model.set('mock_glide_session_store', 'some-session');
        simulateRequest(model, { url: '/logout.do' });
        expect(model.get('mock_glide_session_store')).toBeNull();
      });

      it('after logout, index.do creates a new session', () => {
        const res1 = simulateRequest(model, { url: '/index.do' });
        const cookies1 = parseSetCookie(res1._headers['set-cookie']);
        const firstSession = cookies1.glide_session_store.value;

        simulateRequest(model, { url: '/logout.do' });
        expect(model.get('mock_glide_session_store')).toBeNull();

        const res2 = simulateRequest(model, { url: '/index.do' });
        const cookies2 = parseSetCookie(res2._headers['set-cookie']);
        const secondSession = cookies2.glide_session_store.value;
        expect(secondSession).toBeTruthy();
        expect(secondSession).not.toBe(firstSession);
      });
    });

    describe('GET /nav_to.do', () => {
      it('without cookie redirects to /logout.do', () => {
        const res = simulateRequest(model, { url: '/nav_to.do?uri=sys.scripts.do' });
        expect(res._statusCode).toBe(302);
        expect(res._headers.location).toBe('/logout.do');
      });

      it('with invalid cookie redirects to /logout.do', () => {
        const res = simulateRequest(model, {
          url: '/nav_to.do?uri=sys.scripts.do',
          headers: { cookie: 'glide_session_store=wrong-value' },
        });
        expect(res._statusCode).toBe(302);
        expect(res._headers.location).toBe('/logout.do');
      });

      it('with valid cookie redirects to requested uri', () => {
        simulateRequest(model, { url: '/index.do' });
        const sessionStore = model.get('mock_glide_session_store');

        const res = simulateRequest(model, {
          url: '/nav_to.do?uri=sys.scripts.do',
          headers: { cookie: `glide_session_store=${sessionStore}` },
        });
        expect(res._statusCode).toBe(302);
        expect(res._headers.location).toBe('/sys.scripts.do');
      });

      it('with valid cookie and uri with leading slash redirects to that path', () => {
        simulateRequest(model, { url: '/index.do' });
        const sessionStore = model.get('mock_glide_session_store');

        const res = simulateRequest(model, {
          url: '/nav_to.do?uri=/foo/bar.do',
          headers: { cookie: `glide_session_store=${sessionStore}` },
        });
        expect(res._statusCode).toBe(302);
        expect(res._headers.location).toBe('/foo/bar.do');
      });
    });

    describe('GET wildcard (e.g. /sys.scripts.do)', () => {
      it('without cookie redirects to /logout.do', () => {
        const res = simulateRequest(model, { url: '/sys.scripts.do' });
        expect(res._statusCode).toBe(302);
        expect(res._headers.location).toBe('/logout.do');
      });

      it('with invalid cookie redirects to /logout.do', () => {
        const res = simulateRequest(model, {
          url: '/sys.scripts.do',
          headers: { cookie: 'glide_session_store=invalid' },
        });
        expect(res._statusCode).toBe(302);
        expect(res._headers.location).toBe('/logout.do');
      });

      it('with valid cookie returns 200 and page with Welcome to [uri] and g_ck', () => {
        simulateRequest(model, { url: '/index.do' });
        const sessionStore = model.get('mock_glide_session_store');

        const res = simulateRequest(model, {
          url: '/sys.scripts.do',
          headers: { cookie: `glide_session_store=${sessionStore}` },
        });
        expect(res._statusCode).toBe(200);
        expect(res._body).toContain('Welcome to sys.scripts.do');
        expect(res._body).toContain('g_ck:');
        expect(res._body).toMatch(/window\.g_ck\s*=\s*'[^']+'/);
      });

      it('body g_ck value matches value in script', () => {
        simulateRequest(model, { url: '/index.do' });
        const sessionStore = model.get('mock_glide_session_store');

        const res = simulateRequest(model, {
          url: '/some.module.do',
          headers: { cookie: `glide_session_store=${sessionStore}` },
        });
        const scriptMatch = res._body.match(/window\.g_ck\s*=\s*'([^']+)'/);
        const bodyMatch = res._body.match(/g_ck:\s*([^\s<]+)/);
        expect(scriptMatch).toBeTruthy();
        expect(bodyMatch).toBeTruthy();
        expect(bodyMatch[1]).toBe(scriptMatch[1]);
      });

      it('nav_to then wildcard: valid session serves wildcard page', () => {
        simulateRequest(model, { url: '/index.do' });
        const sessionStore = model.get('mock_glide_session_store');

        const navRes = simulateRequest(model, {
          url: '/nav_to.do?uri=sys.scripts.do',
          headers: { cookie: `glide_session_store=${sessionStore}` },
        });
        expect(navRes._statusCode).toBe(302);
        expect(navRes._headers.location).toBe('/sys.scripts.do');

        const wildcardRes = simulateRequest(model, {
          url: '/sys.scripts.do',
          headers: { cookie: `glide_session_store=${sessionStore}` },
        });
        expect(wildcardRes._statusCode).toBe(200);
        expect(wildcardRes._body).toContain('Welcome to sys.scripts.do');
      });
    });

    describe('session invalidated in background', () => {
      it('wildcard with previously valid cookie returns 302 to logout when model session is null', () => {
        simulateRequest(model, { url: '/index.do' });
        const sessionStore = model.get('mock_glide_session_store');

        model.set('mock_glide_session_store', null);

        const res = simulateRequest(model, {
          url: '/sys.scripts.do',
          headers: { cookie: `glide_session_store=${sessionStore}` },
        });
        expect(res._statusCode).toBe(302);
        expect(res._headers.location).toBe('/logout.do');
      });

      it('nav_to with previously valid cookie returns 302 to logout when model session is null', () => {
        simulateRequest(model, { url: '/index.do' });
        const sessionStore = model.get('mock_glide_session_store');

        model.set('mock_glide_session_store', null);

        const res = simulateRequest(model, {
          url: '/nav_to.do?uri=sys.scripts.do',
          headers: { cookie: `glide_session_store=${sessionStore}` },
        });
        expect(res._statusCode).toBe(302);
        expect(res._headers.location).toBe('/logout.do');
      });
    });

    describe('other paths', () => {
      it('POST returns 404', () => {
        const res = simulateRequest(model, { url: '/index.do', method: 'POST' });
        expect(res._statusCode).toBe(404);
        expect(res._body).toBe('Not Found');
      });
    });
  });

  describe('cookie helpers', () => {
    describe('getGlideSessionStoreFromCookie', () => {
      it('returns value when cookie header has glide_session_store', () => {
        expect(getGlideSessionStoreFromCookie('glide_session_store=abc123')).toBe('abc123');
        expect(getGlideSessionStoreFromCookie('other=val; glide_session_store=xyz; path=/')).toBe('xyz');
      });

      it('returns null when cookie header is missing or empty', () => {
        expect(getGlideSessionStoreFromCookie(null)).toBeNull();
        expect(getGlideSessionStoreFromCookie('')).toBeNull();
      });

      it('returns null when glide_session_store is not present', () => {
        expect(getGlideSessionStoreFromCookie('other=value')).toBeNull();
      });
    });

    describe('isSessionValid', () => {
      it('returns true when cookie matches model value', () => {
        model.set('mock_glide_session_store', 'session-abc');
        expect(isSessionValid(model, 'glide_session_store=session-abc')).toBe(true);
      });

      it('returns false when model has no session', () => {
        expect(isSessionValid(model, 'glide_session_store=anything')).toBe(false);
        model.set('mock_glide_session_store', null);
        expect(isSessionValid(model, 'glide_session_store=anything')).toBe(false);
      });

      it('returns false when cookie does not match model', () => {
        model.set('mock_glide_session_store', 'session-abc');
        expect(isSessionValid(model, 'glide_session_store=wrong')).toBe(false);
      });

      it('returns false when cookie header is missing', () => {
        model.set('mock_glide_session_store', 'session-abc');
        expect(isSessionValid(model, null)).toBe(false);
        expect(isSessionValid(model, '')).toBe(false);
      });
    });
  });

  describe('createMockServer', () => {
    it('returns an http.Server that uses handleRequest', () => {
      const server = createMockServer(model);
      expect(server).toBeDefined();
      expect(typeof server.listen).toBe('function');
      expect(typeof server.close).toBe('function');
    });
  });
});
