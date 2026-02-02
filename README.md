# snow-connector

This module provides **connection state** for ServiceNow instances: it tracks whether a user is logged in (has a valid session) for a given instance and exposes that state through a shared model. Other projects can depend on snow-connector and the same model to react to login/logout (e.g. enable or disable features, sync data only when connected).

## How the session becomes available for Node.js HTTP

A **Puppeteer-controlled browser** is used so the user can log in to ServiceNow in a real browser (with password saving, same-origin behavior, etc.). That browser session is **not** used directly for your Node.js code. Instead:

1. **Cookie sync** – Cookies from the browser (all tabs, all domains) are periodically read and written into the shared model under `${id}_browser_cookies` (a map of domain → cookie string).
2. **Connection** – The Connection class watches `${id}_browser_cookies` for the instance’s domain. When it sees a `glide_session_store` cookie (login), it turns the connection **on**; when that cookie disappears (logout), it turns **off**.
3. **Node.js HTTP** – Your code reads the cookie string for the instance from the model (`${id}_browser_cookies`[domain]) and sends it as the `Cookie` header on any Node.js HTTP request (e.g. using this module’s `httpGet` or your own client). So the **same session** the user established in the browser is reused for server-side requests.

So: **browser session → cookie sync → model → Connection state and cookie string → your HTTP requests.**

## What it provides

- **Connection** – A class that manages connection state per instance (by `id`). It turns **on** when browser cookies for that instance’s domain include `glide_session_store` (e.g. user logs in in a Puppeteer-controlled browser), or when you call `connect()` after a successful health check. It turns **off** when the session cookie disappears (e.g. logout), when the health check fails after a period of inactivity, or when you call `disconnect()`.
- **Model keys** – For each connection `id`, the model holds: `${id}_conn_status` (`'on'` / `'off'`), `${id}_url`, `${id}_validationInterval`, `${id}_browser_cookies`, `${id}_conn_glide_session_store`, `${id}_last_activity`. Your app (or model-manager UI) can read and react to these.
- **Health checker** – Validates the session by requesting a known path (e.g. `/nav_to.do?uri=sys.scripts.do`) with the instance cookies and updates `${id}_last_activity` on success.
- **Providers** – Pluggable model, browser, and health-checker factories so you can use your own model, a real Puppeteer browser, or mocks in tests.
- **Browser and cookie sync** – Helpers to launch Chromium/Chrome or Firefox (with persistent profiles and password saving) and to sync browser cookies from all tabs into the model so Connection can see login/logout.
- **httpGet** – A small HTTP GET helper that follows redirects and accepts an optional `Cookie` header value, so you can pass the session cookie from the model.

## Usage examples

### Declaring a connection and browser, then using the session for HTTP

Assume a shared **model** (e.g. from `model-manager`). The default browser provider is created in `providers.js`; you get it with `getBrowserProvider()`, set the executable path, and launch. If snow-connector is a dependency, use `require('snow-connector/...')`; if it’s the same repo, use relative paths (e.g. `require('./providers.js')`).

```javascript
const model = require('model-manager/model'); // or your model
const { getBrowserProvider } = require('snow-connector/providers.js');
const { Connection } = require('snow-connector/connection.js');
const { startCookieSync } = require('snow-connector/cookieSync.js');
const { httpGet } = require('snow-connector/http.js');

// 1. Configure the browser (optional path = use Puppeteer's Chromium; set one path to use Chrome or Firefox)
let browserPath = null;
// browserPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';   // macOS Chrome
// browserPath = '/Applications/Firefox.app/Contents/MacOS/firefox';                // macOS Firefox
// browserPath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';        // Windows Chrome
// browserPath = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';                  // Windows Firefox

const provider = getBrowserProvider();
provider.setExecutablePath(browserPath);

// 2. Declare a connection for your ServiceNow instance
const connectionId = 0;
const instanceUrl = 'https://your-instance.service-now.com';
model.set(`${connectionId}_url`, instanceUrl);
model.set(`${connectionId}_validationInterval`, 60000); // ms between health checks when stale
const connection = new Connection({ id: connectionId });

// 3. Launch the browser and start syncing cookies (so Connection sees login/logout)
async function startBrowser() {
  await provider.launch({ initialUrl: instanceUrl });
  startCookieSync([connectionId], 2000);
}

// 4. Helpers: get instance URL and session cookie from the model; use them with httpGet to make authenticated requests
function getInstanceUrl() {
  return model.get(`${connectionId}_url`);
}

function getCookieForInstance() {
  const cookiesObj = model.get(`${connectionId}_browser_cookies`);
  if (!cookiesObj || typeof cookiesObj !== 'object') return null;
  const url = getInstanceUrl();
  if (!url) return null;
  const fqdn = new URL(url).hostname;
  return cookiesObj[fqdn] || null;
}

async function fetchWithSession(path) {
  const baseUrl = getInstanceUrl();
  if (!baseUrl) throw new Error('No instance URL');
  const url = (baseUrl.replace(/\/+$/, '') + (path.startsWith('/') ? path : '/' + path));
  const cookie = getCookieForInstance();
  const { statusCode, finalUrl } = await httpGet(url, cookie);
  return { statusCode, finalUrl };
}

// Example: only call the API when connection is on
async function fetchIncidentWhenConnected() {
  if (model.get(`${connectionId}_conn_status`) !== 'on') return;
  const cookie = getCookieForInstance();
  if (!cookie) return;
  const url = getInstanceUrl() + '/api/now/table/incident?sysparm_limit=1';
  const result = await httpGet(url, cookie);
  console.log(result.statusCode, result.finalUrl);
}
```

Summary: set `${id}_url` and `${id}_validationInterval`, create a `Connection({ id })`, run the browser and cookie sync so the model gets `${id}_browser_cookies`. For HTTP, read the cookie string for the instance’s domain from the model and pass it as the second argument to `httpGet(url, cookie)` (or set the `Cookie` header in your own client).

## run.js – example / demo

**run.js** is an **example/demo** script. It:

- Starts a mock ServiceNow server on port 3099 (for trying the flow without a real instance).
- Starts one model-manager **monitor** on port 3031.
- Creates a single Connection (id `0`) for a configurable ServiceNow instance URL.
- Launches a Puppeteer browser with two tabs: the monitor UI, and the instance (or mock).
- Starts cookie sync so connection state follows login/logout in the browser.

You can adapt it for your own use:

1. **Your instance** – Set `instanceUrl` at the top to your ServiceNow instance (e.g. `https://your-instance.service-now.com`). There is a comment in the file: *Update the URL to your ServiceNow instance*.
2. **Browser** – By default the script uses Puppeteer’s bundled Chromium. To use Chrome or Firefox, uncomment the corresponding `browserPath` line (macOS/Windows examples are in the file).

With `node run` (or `npm start`) running, open the **monitor** in your browser at **http://localhost:3031**. You’ll see the shared model, including keys like `0_conn_status`, `0_browser_cookies`, `0_last_activity`. Log in to the ServiceNow instance in the other tab; connection turns **on** and last activity is set. Log out (or clear the session cookie); connection turns **off**. The monitor shows how connection state changes as you log in and out.

## Integration tests

**Integration tests require the mock ServiceNow server to be running on port 3099.** The demo **run.js** starts this server. To run the full test suite:

1. Start the demo: `node run` (or `npm start`).
2. In another terminal, run: `npm test`.

If the mock server is not running, the integration specs will fail with a message telling you to run `node run` first.

## Scripts

- `npm start` – Runs `node run.js` (demo with mock, monitor, browser, and cookie sync).
- `npm test` – Runs Jasmine (unit and integration). Start `node run` first for integration tests.
