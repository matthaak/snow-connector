# snow-connector

`snow-connector` provides a browser-based connection to a ServiceNow instance so regular users can interact programmatically from Node without requiring admin-managed service accounts or OAuth setup.

Because it is browser-based, it works with real login environments (including SSO, proxies, and browser password saving). For example, regular users can use `snow-connector` to access the ServiceNow Table API.

## How connectivity works

A Puppeteer-controlled browser is used so users authenticate through an actual browser session.

A **worker tab** is the browser tab context `snow-connector` uses for fetches and health checks. The connector keeps this capability available using deterministic tab-selection and provisioning rules (defined in the Decision Table below), so callers can program against a known connection state.

Conceptually:

- Consumer requests are passed through browser-context fetch so they use the active user session.
- Health checks run to keep connection state known over time.
- When an eligible fetch tab is unavailable, provisioning rules create/reuse the right tab context.
- `g_ck` values are synced into the observable model for development visibility and consumer use.

## What it provides

- **Connection** – A class that manages connection state per instance. Each instance gets a numeric `id` assigned sequentially (from the model). It applies explicit connect/health/consumer behavior rules (see Decision Table below).
- **Observable model** – Internal connector state is published through the shared model and can be observed during development in a browser-based monitor.
- **Model keys** – For each connection `id`, the model holds: `${id}_conn_status` (`'on'` / `'off'`), `${id}_conn_key`, `${id}_url`, `${id}_validationInterval`, `${id}_last_activity`, `${id}_glide_session_store` (cookie value or `null`). Global key **browser_g_cks** (domain → value) is updated by browser sync and worker-tab sync.
- **Health checker** – Runs periodic health checks using the same fetch/navigation semantics as the decision table. Key rotation is explicit and scenario-dependent.
- **Worker tab and reset** – `connection.fetch(url, options)` runs `fetch` in an eligible tab context and updates `${id}_last_activity` on success. `connection.reset()` provisions navigation to the current dynamic health path.
- **Browser sync** – Helpers to launch Chromium/Chrome or Firefox (with persistent profiles and password saving) and to sync `g_ck` into the model on each page load.

## Usage examples

### Declaring a connection and making requests

Assume a shared **model** (e.g. from `observable-state-model`). If snow-connector is a dependency, use `require('snow-connector/...')`; if it’s the same repo, use relative paths (e.g. `require('./providers.js')`).

#### Optional: choose a specific browser executable

This step is optional. If omitted, Snow-Connector uses Puppeteer's built-in Chromium browser or the browser path set in the `SNOW_CONNECTOR_BROWSER` environment variable.

```javascript
const provider = require('snow-connector/providers.js').getBrowserProvider();

// Uncomment one of the below lines to override the default browser selected by snow-connector or set by the SNOW_CONNECTOR_BROWSER environment variable
// provider.setExecutablePath('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
// provider.setExecutablePath('/Applications/Firefox.app/Contents/MacOS/firefox');
// provider.setExecutablePath('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
// provider.setExecutablePath('C:\\Program Files\\Mozilla Firefox\\firefox.exe');
```

#### Connection usage

```javascript
const { Connection } = require('snow-connector/connection.js');

// 1. Declare a connection for your ServiceNow instance (id is assigned sequentially by Connection)
const instanceUrl = 'https://your-instance.service-now.com';
const connection = new Connection({
  instanceUrl,
  validationInterval: 60000, // optional, defaults to 15000 ms; health tab reload interval
  // browserProvider: provider, // optional, only needed if provider was configured for a specific browser
});

// 2. Wait for connection startup once.
await connection.ready();

// 3. Use connection.fetch when connected
async function callInstanceApi() {
  if (!connection.isOn()) return;
  const res = await connection.fetch('/api/now/table/incident?sysparm_limit=1');
  console.log('Fetch status:', res.status, res.body);
}
```

Summary: create a `Connection({ instanceUrl, validationInterval?, browserProvider? })`; the connection gets an `id` assigned from the model. `startBrowserSync()` is optional if you also want global `g_ck` model sync from other tabs/domains. When the connection is on, use `connection.fetch(url, options)` for API calls (updates `${id}_last_activity`). `connection.fetch` is instance-specific: it requires relative URLs, resolves them to the configured instance, and automatically adds `X-UserToken` (from `g_ck`) when missing, which is needed for many operations. `validationInterval` defaults to 15000 ms if omitted.

### Connection API for consumers

- `await connection.ready()` - Wait for startup initialization.
- `await connection.connect()` - Attempt to establish/confirm connectivity; resolves `true` on success.
- `connection.isOn()` - Return current connection state (`true`/`false`).
- `await connection.fetch('/relative/path', options?)` - Execute instance-scoped request. URL must be relative; connector resolves to instance base URL and auto-adds `X-UserToken` when missing. `options` follow the browser Fetch API `RequestInit` shape (for example `method`, `headers`, `body`).
- `await connection.reset()` - Re-provision navigation to the current health path (optional operational control).
- `connection.disconnect()` - Mark connection OFF and rotate conn key.

## Decision table (source of truth)

| Scenario | Fetchable | Fetch Result | Nav Result | Conn State | Key | Description |
|---|---|---|---|---|---|---|
| Connect | Yes | Success | N/A | mark ON | ROTATE | Fetch health probe reached current success suffix, so **mark ON** and **ROTATE key**. |
| Connect | Yes | Fail | Success | mark ON | ROTATE | Fetch health probe failed, then navigation reached current success suffix, so **mark ON** and **ROTATE key**. |
| Connect | Yes | Fail | Fail | keep OFF | PRESERVE | Fetch health probe failed, and navigation never reached success suffix, so **keep OFF** and **PRESERVE key** in case of eventual future login success. |
| Connect | No | N/A | Success | mark ON | ROTATE | No fetchable tab; navigation provisioning reached current success suffix, so **mark ON** and **ROTATE key**. |
| Connect | No | N/A | Fail | keep OFF | PRESERVE | No fetchable tab; navigation provisioning never reached success suffix, so **keep OFF** and **PRESERVE key** in case of eventual future login success. |
| Health | Yes | Success | N/A | keep ON | ROTATE | Health fetch reached current success suffix, so **keep ON** and **ROTATE key**. |
| Health | Yes | Fail | N/A | mark OFF | ROTATE | Health fetch failed to reach current success suffix, so **mark OFF** and **ROTATE key**; navigation is not provisioned after failed health fetches. |
| Health | No | N/A | Success | keep ON | ROTATE | No fetchable tab; health navigation provisioning reached current success suffix, so **keep ON** and **ROTATE key**. |
| Health | No | N/A | Fail | mark OFF | ROTATE | No fetchable tab; health navigation provisioning landed off-suffix, so **mark OFF** and **ROTATE key**. |
| Consumer | Yes | N/A | N/A | (no impact) | (no impact) | Connector executes consumer fetch on selected fetch tab. Connection must first be ON, else an exception is thrown. Consumer ultimately decides if the fetch is a success or fail. |
| Consumer | No | N/A | Success | keep ON | ROTATE | No fetchable tab; connector provisions navigation to current success path. If navigation reaches suffix, **keep ON** and **ROTATE key**, then proceed with consumer fetch attempt. |
| Consumer | No | N/A | Fail | mark OFF | ROTATE | No fetchable tab; connector provisions navigation and it landed off-suffix, so **mark OFF** and **ROTATE key**, then throw exception to consumer. |

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
- Starts browser sync so `browser_g_cks` is kept current as pages load.

You can adapt it for your own use:

1. **Demo instance** – The demo uses `instanceUrl` for the Connection; this is dev tooling only, not part of the connector contract. Default is `https://your-instance.service-now.com`. Set the `SNOW_CONNECTOR_DEMO_INSTANCE` environment variable to use a specific instance, or edit the default in the file.
2. **Browser** – Snow-Connector uses Puppeteer’s bundled Chromium by default, or the path in `SNOW_CONNECTOR_BROWSER` if set. To override in the demo, uncomment one of the `provider.setExecutablePath(...)` lines in `run.js` (macOS/Windows examples are in the file).

With `node run` (or `npm start`) running, open the **monitor** in your browser at **[http://localhost:3031](http://localhost:3031)**. You’ll see the shared model, including keys like `0_conn_status` (or `1_conn_status`, etc., per connection id), `browser_g_cks`, and `0_last_activity`. Log in to the ServiceNow instance in the browser tab opened by the script; connection turns **on** and last activity is set. Log out; connection turns **off**. The monitor shows how connection state changes as you log in and out.

## Integration tests

**Integration tests require the mock ServiceNow server to be running on port 3099.** The demo **run.js** starts this server. To run the full test suite:

1. Start the demo: `node run` (or `npm start`).
2. In another terminal, run: `npm test`.

If the mock server is not running, the integration specs will fail with a message telling you to run `node run` first.

## Scripts

- `npm start` – Runs `node run.js` (demo with mock, monitor, browser, and browser sync).
- `npm test` – Runs Jasmine (unit and integration). Start `node run` first for integration tests.

