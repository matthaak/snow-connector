const http = require('http');
const crypto = require('crypto');

const HOST = '127.0.0.1';
const PORT = 3099;
const SESSION_KEY = 'mock_glide_session_store';

function randomGuid() {
  return crypto.randomUUID();
}

function getOrCreateSessionStore(model) {
  let value = model.get(SESSION_KEY);
  if (value == null || value === '') {
    value = randomGuid();
    model.set(SESSION_KEY, value);
  }
  return value;
}

function getGlideSessionStoreFromCookie(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;
  const match = cookieHeader.match(/glide_session_store=([^;]+)/);
  return match ? match[1].trim() : null;
}

function isSessionValid(model, cookieHeader) {
  const stored = model.get(SESSION_KEY);
  if (stored == null || stored === '') return false;
  const cookie = getGlideSessionStoreFromCookie(cookieHeader);
  return cookie !== null && cookie === stored;
}

function handleRequest(model, req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/index.do' && req.method === 'GET') {
      const glideSessionStore = getOrCreateSessionStore(model);
      const gCk = randomGuid();

      const body = `<!DOCTYPE html>
<html>
<head>
  <script>window.g_ck = '${gCk}';</script>
</head>
<body>
  <p>Welcome to the mock instance!</p>
  <p>glide_session_store: ${glideSessionStore}</p>
  <p>g_ck: ${gCk}</p>
</body>
</html>`;

      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Set-Cookie': `glide_session_store=${glideSessionStore}; HttpOnly`,
      });
      res.end(body);
      return;
    }

    // Test helper: invalidate session so integration tests can assert connect() fails with invalid/expired session
    if (pathname === '/test/invalidate-session' && req.method === 'GET') {
      model.set(SESSION_KEY, null);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      return;
    }

    if (pathname === '/logout.do' && req.method === 'GET') {
      model.set(SESSION_KEY, null);

      const body = `<!DOCTYPE html>
<html>
<head>
</head>
<body>
  <p>Logged out.</p>
</body>
</html>`;

      res.writeHead(200, {
        'Content-Type': 'text/html',
      });
      res.end(body);
      return;
    }

    if (pathname === '/nav_to.do' && req.method === 'GET') {
      const uri = url.searchParams.get('uri') || '';
      const targetPath = uri.startsWith('/') ? uri : `/${uri}`;

      if (isSessionValid(model, req.headers.cookie)) {
        res.writeHead(302, { Location: targetPath });
        res.end();
      } else {
        res.writeHead(302, { Location: '/logout.do' });
        res.end();
      }
      return;
    }

    // Wildcard: any path other than index.do, logout.do, nav_to.do
    if (req.method === 'GET') {
      if (!isSessionValid(model, req.headers.cookie)) {
        res.writeHead(302, { Location: '/logout.do' });
        res.end();
        return;
      }

      const gCk = randomGuid();
      const displayUri = pathname.startsWith('/') ? pathname.slice(1) || pathname : pathname;

      const body = `<!DOCTYPE html>
<html>
<head>
  <script>window.g_ck = '${gCk}';</script>
</head>
<body>
  <p>Welcome to ${displayUri}</p>
  <p>g_ck: ${gCk}</p>
</body>
</html>`;

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(body);
      return;
    }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

function createMockServer(model) {
  const server = http.createServer((req, res) => handleRequest(model, req, res));
  return server;
}

function startMockServiceNow(model) {
  const server = createMockServer(model);
  server.listen(PORT, HOST, () => {
    console.log(`Mock ServiceNow instance at http://localhost:${PORT}`);
  });
  return server;
}

module.exports = {
  startMockServiceNow,
  createMockServer,
  handleRequest,
  getOrCreateSessionStore,
  getGlideSessionStoreFromCookie,
  isSessionValid,
  randomGuid,
};
