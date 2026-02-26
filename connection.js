// connection.js
/**
 * Connection class manages connection state to a ServiceNow instance.
 *
 * Connection uses a single worker tab for login, health checks, and consumer requests.
 * Consumers use connection.fetch() (or getWorkerPage()) and can reset to HEALTH_PATH via reset().
 * Health checking uses the same worker tab and runs at validationInterval.
 *
 * Connection Methods (turning "on"):
 * - Method A: Attempts health check when cookies for the connection domain change;
 *   turns on when the health path succeeds. Handled by handleModelChange().
 * - Method B: Manually turns on via connect() / ensureHealthTab() when health check passes.
 *
 * Disconnection Methods (turning "off"):
 * - Method P: Health check via worker fetch reports failure (e.g. redirect to logout);
 *   connection status is set off and periodic check is stopped.
 * - Method Q: Manually disconnects via disconnect() method.
 * - Method R: Periodic health checks detect logout/invalid session and turn off on failure.
 */

const {
  getModelProvider,
  getBrowserProvider,
  getHealthCheckerFactory,
} = require('./providers.js');
const { buildHealthCheckUrl, pathEndsWithSuccessSuffix } = require('./healthChecker.js');

const MODEL_NEXT_ID_KEY = '_snow_connector_next_id';

function getNextConnectionId(model) {
  const next = model.get(MODEL_NEXT_ID_KEY);
  const id = next != null && Number.isFinite(next) ? next : 0;
  model.set(MODEL_NEXT_ID_KEY, id + 1);
  return id;
}

class Connection {
  constructor({
    instanceUrl,
    validationInterval = 15000,
    browserProvider = getBrowserProvider(),
  }) {
    this.model = getModelProvider().getModel();
    this.id = getNextConnectionId(this.model);
    this.healthChecker = getHealthCheckerFactory().create(this.id);
    this.browserProvider = browserProvider;

    // Initialize connection status
    const statusKey = `${this.id}_conn_status`;
    this.model.set(statusKey, 'off');

    // Store key names for convenience (url and validationInterval read from model)
    this.statusKey = statusKey;
    this.urlKey = `${this.id}_url`;
    this.validationIntervalKey = `${this.id}_validationInterval`;

    // Populate model with connection config
    this.model.set(this.urlKey, instanceUrl);
    this.model.set(this.validationIntervalKey, validationInterval);
    this.cookiesKey = 'browser_cookies'; // Object: domain -> cookie string
    this.lastActivityKey = `${this.id}_last_activity`;

    // Single worker tab used for login/health/consumer fetches.
    this.workerPage = null;
    this.workerPagesWithLoadListener = new WeakSet();
    this.suppressCookieDrivenChecks = false;

    if (this.healthChecker && typeof this.healthChecker.setWorkerPageProvider === 'function') {
      this.healthChecker.setWorkerPageProvider(this._getOrCreateWorkerPage.bind(this));
    }
    if (this.healthChecker && typeof this.healthChecker.setWorkerFetchProvider === 'function') {
      this.healthChecker.setWorkerFetchProvider(this._workerFetch.bind(this));
    }
    this.initializationPromise = this._initializeBrowserAndWorker();

    // Listen for browser cookies changes
    this.model.on('change', this.handleModelChange.bind(this));
  }

  async _initializeBrowserAndWorker() {
    try {
      const provider = this.browserProvider;
      let browser = provider && typeof provider.getBrowser === 'function'
        ? provider.getBrowser()
        : null;
      const connected = browser && typeof browser.isConnected === 'function' && browser.isConnected();
      const healthUrl = buildHealthCheckUrl(this.getBaseURL()) || this.getBaseURL();
      if (!connected && provider && typeof provider.launch === 'function') {
        await provider.launch({ initialUrl: healthUrl || undefined });
        browser = provider.getBrowser();
        if (browser && typeof browser.pages === 'function') {
          const pages = await browser.pages().catch(() => []);
          const firstOpenPage = pages.find((page) => page && typeof page.isClosed === 'function' && !page.isClosed());
          if (firstOpenPage) {
            this.workerPage = firstOpenPage;
            this._attachWorkerPageLoadListener(this.workerPage);
            await this._syncBrowserStateFromWorkerPage(this.workerPage);
          }
        }
      }
      if (this.healthChecker && typeof this.healthChecker.ensureHealthTab === 'function') {
        await Promise.resolve(this.healthChecker.ensureHealthTab());
      }
    } catch (e) {
      // Keep connection down; methods can retry creating the worker tab later.
    }
  }

  async ready() {
    await this._ensureInitialized();
  }

  async _ensureInitialized() {
    if (!this.initializationPromise) {
      return;
    }
    await this.initializationPromise;
  }

  getUrlFqdn() {
    const url = this.model.get(this.urlKey);
    return this.extractFqdn(url);
  }

  /**
   * Returns true when this connection's status is currently on.
   * @returns {boolean}
   */
  isOn() {
    return this.model.get(this.statusKey) === 'on';
  }

  /**
   * Returns this connection's configured base URL from the model.
   * @returns {string|null}
   */
  getBaseURL() {
    const url = this.model.get(this.urlKey);
    return typeof url === 'string' && url ? url : null;
  }

  /**
   * Extracts FQDN from a URL (e.g., "https://dev224422.service-now.com" -> "dev224422.service-now.com")
   * @param {string} url - The URL to extract FQDN from
   * @returns {string|null} The FQDN or null if invalid
   */
  extractFqdn(url) {
    if (!url || typeof url !== 'string') {
      return null;
    }
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch (e) {
      // If URL parsing fails, try to extract manually
      const match = url.match(/https?:\/\/([^\/]+)/);
      return match ? match[1] : null;
    }
  }

  handleModelChange(event) {
    // Only process changes to the browser cookies key
    if (event.key !== this.cookiesKey) {
      return;
    }
    if (this.suppressCookieDrivenChecks) {
      return;
    }

    // Get the cookies object (domain -> cookie string mapping)
    const newCookiesObj = event.newValue || {};
    const oldCookiesObj = event.oldValue || {};

    // Get cookies for this connection's domain
    const urlFqdn = this.getUrlFqdn();
    const newCookieValue = (typeof newCookiesObj === 'object' && newCookiesObj !== null) 
      ? newCookiesObj[urlFqdn] 
      : null;
    const oldCookieValue = (typeof oldCookiesObj === 'object' && oldCookiesObj !== null) 
      ? oldCookiesObj[urlFqdn] 
      : null;

    // Only react when this connection domain's cookie value changed, and only while off.
    if (this.isOn() || newCookieValue === oldCookieValue) {
      return;
    }

    if (this.healthChecker && typeof this.healthChecker.doCheck === 'function') {
      Promise.resolve(this.healthChecker.doCheck()).then((ok) => {
        if (ok && !this.isOn()) {
          this.model.set(this.statusKey, 'on');
          this.model.set(this.lastActivityKey, Date.now());
          if (typeof this.healthChecker.startPeriodicCheck === 'function') {
            this.healthChecker.startPeriodicCheck();
          }
        }
      }).catch(() => {});
    }
  }

  /**
   * Ensures the health/login tab exists and is on the instance health URL.
   * Call after browser launch so the user has one tab to log in on.
   * @returns {Promise<boolean>} true if tab is open and navigated
   */
  async ensureHealthTab() {
    await this._ensureInitialized();
    if (!this.healthChecker || typeof this.healthChecker.ensureHealthTab !== 'function') {
      return false;
    }
    const opened = await Promise.resolve(this.healthChecker.ensureHealthTab());
    if (!opened) {
      return false;
    }
    const page = await this._getOrCreateWorkerPage();
    if (page && !page.isClosed() && pathEndsWithSuccessSuffix(page.url())) {
      if (!this.isOn()) {
        this.model.set(this.statusKey, 'on');
      }
      this.model.set(this.lastActivityKey, Date.now());
      if (typeof this.healthChecker.startPeriodicCheck === 'function') {
        this.healthChecker.startPeriodicCheck();
      }
      return true;
    }
    if (!this.healthChecker || typeof this.healthChecker.doCheck !== 'function') {
      return opened;
    }
    const ok = await Promise.resolve(this.healthChecker.doCheck()).catch(() => false);
    if (ok && !this.isOn()) {
      this.model.set(this.statusKey, 'on');
      this.model.set(this.lastActivityKey, Date.now());
      if (typeof this.healthChecker.startPeriodicCheck === 'function') {
        this.healthChecker.startPeriodicCheck();
      }
    }
    return opened;
  }

  async _getOrCreateWorkerPage() {
    const provider = this.browserProvider;
    const browser = provider && typeof provider.getBrowser === 'function'
      ? provider.getBrowser()
      : null;
    if (!browser || !browser.isConnected()) {
      return null;
    }
    if (this.workerPage && !this.workerPage.isClosed()) {
      this._attachWorkerPageLoadListener(this.workerPage);
      return this.workerPage;
    }
    const instanceUrl = this.getBaseURL();
    const healthUrl = buildHealthCheckUrl(instanceUrl);
    if (!healthUrl) {
      return null;
    }
    try {
      this.workerPage = await browser.newPage();
      this._attachWorkerPageLoadListener(this.workerPage);
      await this.workerPage.goto(healthUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this._syncBrowserStateFromWorkerPage(this.workerPage);
      return this.workerPage;
    } catch (e) {
      if (this.workerPage && !this.workerPage.isClosed()) {
        await this.workerPage.close().catch(() => {});
      }
      this.workerPage = null;
      return null;
    }
  }

  _attachWorkerPageLoadListener(page) {
    if (!page || this.workerPagesWithLoadListener.has(page) || typeof page.on !== 'function') {
      return;
    }
    page.on('load', () => {
      this._syncBrowserStateFromWorkerPage(page).catch(() => {});
      const currentUrl = typeof page.url === 'function' ? page.url() : null;
      const success = pathEndsWithSuccessSuffix(currentUrl);
      if (success && !this.isOn()) {
        this.model.set(this.statusKey, 'on');
        this.model.set(this.lastActivityKey, Date.now());
        if (this.healthChecker && typeof this.healthChecker.startPeriodicCheck === 'function') {
          this.healthChecker.startPeriodicCheck();
        }
        return;
      }
      if (!success && this.isOn()) {
        this.model.set(this.statusKey, 'off');
        this._stopHealthAndWorker();
      }
    });
    this.workerPagesWithLoadListener.add(page);
  }

  async _syncBrowserStateFromWorkerPage(page) {
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
      return;
    }
    const url = typeof page.url === 'function' ? page.url() : null;
    const fqdn = this.extractFqdn(url);
    if (!fqdn) {
      return;
    }

    if (typeof page.cookies === 'function') {
      try {
        const cookies = await page.cookies();
        const cookieString = Array.isArray(cookies)
          ? cookies.map((c) => `${c.name}=${c.value || ''}`).join('; ')
          : '';
        const currentCookies = this.model.get(this.cookiesKey) || {};
        this.suppressCookieDrivenChecks = true;
        this.model.set(this.cookiesKey, { ...currentCookies, [fqdn]: cookieString });
        this.suppressCookieDrivenChecks = false;
      } catch (e) {
        this.suppressCookieDrivenChecks = false;
        // ignore
      }
    }

    if (typeof page.evaluate === 'function') {
      try {
        const gck = await page.evaluate(() => {
          try {
            if (typeof window !== 'undefined' && typeof window.g_ck !== 'undefined') {
              return window.g_ck != null ? String(window.g_ck) : null;
            }
            if (typeof globalThis !== 'undefined' && typeof globalThis.g_ck !== 'undefined') {
              return globalThis.g_ck != null ? String(globalThis.g_ck) : null;
            }
            if (typeof g_ck !== 'undefined') {
              return g_ck != null ? String(g_ck) : null;
            }
            return null;
          } catch (err) {
            return null;
          }
        });
        if (gck != null) {
          const currentGcks = this.model.get('browser_g_cks') || {};
          this.model.set('browser_g_cks', { ...currentGcks, [fqdn]: gck });
        }
      } catch (e) {
        // ignore
      }
    }
  }

  async _workerFetch(url, options = {}, { requireOn = true } = {}) {
    await this._ensureInitialized();
    if (requireOn && !this.isOn()) {
      throw new Error('Connection is off or worker page unavailable');
    }
    const page = requireOn ? await this.getWorkerPage() : await this._getOrCreateWorkerPage();
    if (!page) {
      throw new Error('Connection is off or worker page unavailable');
    }
    const init = {
      method: (options.method || 'GET').toUpperCase(),
      headers: options.headers && typeof options.headers === 'object' ? options.headers : {},
      body: options.body != null ? String(options.body) : undefined,
    };
    return page.evaluate(
      async ({ url: u, init: i }) => {
        const res = await fetch(u, i);
        const body = await res.text();
        return {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          headers: Object.fromEntries(res.headers.entries()),
          body,
          finalUrl: res.url,
        };
      },
      { url, init }
    );
  }

  /**
   * Returns the worker tab page for this connection. Creates it if connection is on and not yet created.
   * @returns {Promise<import('puppeteer').Page|null>} The worker page or null if connection is off or browser unavailable
   */
  async getWorkerPage() {
    await this._ensureInitialized();
    if (!this.isOn()) {
      return null;
    }
    return this._getOrCreateWorkerPage();
  }

  /**
   * Runs fetch in the worker tab page context (same origin/cookies as the instance) and updates
   * the model's last-activity timestamp on success.
   * @param {string} url - URL to fetch (relative to instance or absolute)
   * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [options] - fetch init (method, headers, body)
   * @returns {Promise<{ ok: boolean, status: number, statusText: string, headers: Record<string, string>, body: string }>} serialized response, or rejects if no worker page or fetch fails
   */
  async fetch(url, options = {}) {
    const result = await this._workerFetch(url, options, { requireOn: true });
    this.model.set(this.lastActivityKey, Date.now());
    return result;
  }

  /**
   * Navigates the worker tab to HEALTH_PATH. No-op if connection is off or worker page not created.
   * @returns {Promise<void>}
   */
  async reset() {
    if (!this.workerPage || this.workerPage.isClosed()) {
      return;
    }
    const url = this.model.get(this.urlKey);
    const healthUrl = buildHealthCheckUrl(url);
    if (!healthUrl) {
      return;
    }
    try {
      await this.workerPage.goto(healthUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      // ignore
    }
  }

  /**
   * Method B: Manually connect the connection.
   * Requires health check to pass.
   * @returns {Promise<boolean>} Resolves with true if connection was turned on, false otherwise
   */
  async connect() {
    await this._ensureInitialized();
    const ensured = await this.ensureHealthTab();
    if (ensured && this.isOn()) {
      return true;
    }

    // Method B: Perform health check via worker fetch; on success start periodic check
    if (this.healthChecker && typeof this.healthChecker.doCheck === 'function') {
      const ok = await Promise.resolve(this.healthChecker.doCheck());
      if (ok) {
        this.model.set(this.statusKey, 'on');
        this.model.set(this.lastActivityKey, Date.now());
        if (typeof this.healthChecker.startPeriodicCheck === 'function') {
          this.healthChecker.startPeriodicCheck();
        }
        return true;
      }
    }

    return false;
  }

  /**
   * Method Q: Manually disconnect the connection.
   */
  disconnect() {
    this.model.set(this.statusKey, 'off');
    this._stopHealthAndWorker();
  }

  /**
   * Stops health checker periodic check.
   * The worker tab is intentionally left open so reconnect can reuse it.
   * If the user manually closes it, a new tab is created on demand.
   */
  _stopHealthAndWorker() {
    if (this.healthChecker && typeof this.healthChecker.stopPeriodicCheck === 'function') {
      Promise.resolve(this.healthChecker.stopPeriodicCheck()).catch(() => {});
    }
  }
}

module.exports = { Connection };
