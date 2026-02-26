# snow-connector

This module provides **connection state** for ServiceNow instances: it tracks whether a user is logged in (has a valid session) for a given instance and exposes that state through a shared model. Other projects can depend on snow-connector and the same model to react to login/logout (e.g. enable or disable features, sync data only when connected).

## How connectivity works

A **Puppeteer-controlled browser** is used so the user can log in to ServiceNow in a real browser (with password saving, same-origin behavior, etc.). Consuming apps use a **worker tab** that snow-connector sets up, so all requests run in the browser with the same cookies and session.

1. **Browser sync** – On each page load (any tab, any domain), cookies and g_ck for that page's domain are written into the shared model: **browser_cookies** (domain → cookie string) and **browser_g_cks** (domain → detected g_ck value). No interval; updates are driven by the browser load event.
2. **Connection** – The Connection class uses health checks against the instance health path. Connection turns **on** when that health check lands on the success path, and turns **off** when health checks fail (for example, after logout/redirect).
3. **Worker tab** – A single worker tab is used for login, health checks, and consumer requests. Use `connection.fetch()` for instance requests (same browser cookies/session), and call `connection.reset()` to navigate the worker tab to the health path (e.g. `sys.scripts.do`) when needed.

So: **browser session → browser sync → model → Connection state → worker tab for your app.**

## What it provides

- **Connection** – A class that manages connection state per instance. Each instance gets a numeric `id` assigned sequentially (from the model). It turns **on** when a health check succeeds (success path reached), including from `connect()` / `ensureHealthTab()`. It turns **off** when health checks fail after inactivity/redirect, or when you call `disconnect()`.
- **Model keys** – For each connection `id`, the model holds: `${id}_conn_status` (`'on'` / `'off'`), `${id}_url`, `${id}_validationInterval`, `${id}_last_activity`. Global keys **browser_cookies** and **browser_g_cks** (domain → value) are updated by browser sync or worker-tab sync. Your app (or observable-state-model monitor UI) can read and react to these. The Connection constructor assigns the next available `id` and sets `${id}_url` and `${id}_validationInterval` in the model from its `instanceUrl` and `validationInterval` (default 15000) arguments.
- **Health checker** – Runs through the worker fetch flow against the health path (e.g. `/nav_to.do?uri=sys.scripts.do`) at the connection’s validation interval. Success is detected when the final response URL path ends with the expected suffix; otherwise the connection is reported down and `${id}_last_activity` is updated on success.
- **Worker tab and reset** – `connection.fetch(url, options)` runs `fetch` in the worker tab context and updates `${id}_last_activity` on success. `connection.getWorkerPage()` still returns the Puppeteer page when needed, and `connection.reset()` navigates it to the health path.
- **Providers** – Pluggable model, browser, and health-checker factories so you can use your own model, a real Puppeteer browser, or mocks in tests.
- **Browser sync** – Helpers to launch Chromium/Chrome or Firefox (with persistent profiles and password saving) and to sync browser state (cookies and g_ck) into the model on each page load so Connection can see login/logout.

## Usage examples

### Declaring a connection and using the worker tab

Assume a shared **model** (e.g. from `observable-state-model`). The default browser provider is created in `providers.js`; you get it with `getBrowserProvider()`, set the executable path, and pass it to `Connection`. Connection launches the browser if needed and creates the login/worker tab on the health path. If snow-connector is a dependency, use `require('snow-connector/...')`; if it’s the same repo, use relative paths (e.g. `require('./providers.js')`).

```javascript
const { getBrowserProvider } = require('snow-connector/providers.js');
const { Connection } = require('snow-connector/connection.js');

// 1. Configure the browser (optional path = use Puppeteer's Chromium; set one path to use Chrome or Firefox)
let browserPath = null;
// browserPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';   // macOS Chrome
// browserPath = '/Applications/Firefox.app/Contents/MacOS/firefox';                // macOS Firefox
// browserPath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';        // Windows Chrome
// browserPath = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';                  // Windows Firefox

const provider = getBrowserProvider();
provider.setExecutablePath(browserPath);

// 2. Declare a connection for your ServiceNow instance (id is assigned sequentially by Connection)
const instanceUrl = 'https://your-instance.service-now.com';
const connection = new Connection({
  instanceUrl,
  validationInterval: 60000, // optional, defaults to 15000 ms; health tab reload interval
  browserProvider: provider, // required for auto-launch/worker-tab creation
});

// 3. Wait for connection startup once.
await connection.ready();

// 4. Use connection.fetch when connected
async function useWorkerTab() {
  if (!connection.isOn()) return;
  const res = await connection.fetch(`${instanceUrl}/api/now/table/incident?sysparm_limit=1`);
  console.log('Fetch status:', res.status, res.body);
  // Use connection.reset() to navigate the worker tab back to the health path when needed.
  // Or reset the worker tab to the health path
  await connection.reset();
}
```

Summary: create a `Connection({ instanceUrl, validationInterval?, browserProvider? })`; the connection gets an `id` assigned from the model. Connection launches the browser if needed using the instance health URL as initial URL, creates/uses a login-worker tab on the health path, and syncs that worker tab’s cookies into the model for login detection. `startBrowserSync()` is optional if you also want model sync from other tabs/domains. When the connection is on, use `connection.fetch(url, options)` for API calls (updates `${id}_last_activity`) and use `connection.reset()` to navigate the worker tab to the health path. `validationInterval` defaults to 15000 ms if omitted.

If you want to run an observable-state-model monitor listener, use the single package import:

```javascript
const { model, ModelManager } = require('observable-state-model');
new ModelManager(3031, model).start();
```

## run.js – example / demo

**run.js** is an **example/demo** script. It:

- Starts a mock ServiceNow server on port 3099 (for trying the flow without a real instance).
- Starts one observable-state-model **monitor** on port 3031.
- Creates a single Connection for a configurable ServiceNow instance URL (its `id` is assigned sequentially).
- Launches a Puppeteer browser to the instance login/worker tab (health path).
- Starts browser sync so connection state follows login/logout in the browser.

You can adapt it for your own use:

1. **Your instance** – Set `instanceUrl` at the top to your ServiceNow instance (e.g. `https://your-instance.service-now.com`). There is a comment in the file: *Update the URL to your ServiceNow instance*.
2. **Browser** – By default the script uses Puppeteer’s bundled Chromium. To use Chrome or Firefox, uncomment the corresponding `browserPath` line (macOS/Windows examples are in the file).

With `node run` (or `npm start`) running, open the **monitor** in your browser at **[http://localhost:3031](http://localhost:3031)**. You’ll see the shared model, including keys like `0_conn_status` (or `1_conn_status`, etc., per connection id), `browser_cookies`, and `0_last_activity`. Log in to the ServiceNow instance in the browser tab opened by the script; connection turns **on** and last activity is set. Log out (or clear the session cookie); connection turns **off**. The monitor shows how connection state changes as you log in and out.

## Integration tests

**Integration tests require the mock ServiceNow server to be running on port 3099.** The demo **run.js** starts this server. To run the full test suite:

1. Start the demo: `node run` (or `npm start`).
2. In another terminal, run: `npm test`.

If the mock server is not running, the integration specs will fail with a message telling you to run `node run` first.

## Scripts

- `npm start` – Runs `node run.js` (demo with mock, monitor, browser, and browser sync).
- `npm test` – Runs Jasmine (unit and integration). Start `node run` first for integration tests.

