const {
  getModelProvider,
  getBrowserProvider,
  getHealthCheckerFactory,
} = require('./providers.js');
const { randomUUID } = require('crypto');
const { buildHealthCheckUrl, buildSuccessSuffix, pathEndsWithSuccessSuffix } = require('./healthChecker.js');
const { syncGckForPage } = require('./gckSync.js');

const MODEL_NEXT_ID_KEY = '_snow_connector_next_id';
const BLANK_PATH_SUFFIX = '/ws_blank_page.do';
const SAFE_NAV_PATHS = new Set(['/', '/login.do', '/navpage.do', '/welcome.do']);

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

    this.statusKey = `${this.id}_conn_status`;
    this.urlKey = `${this.id}_url`;
    this.validationIntervalKey = `${this.id}_validationInterval`;
    this.lastActivityKey = `${this.id}_last_activity`;
    this.connKeyKey = `${this.id}_conn_key`;
    this.glideSessionStoreKey = `${this.id}_glide_session_store`;

    this.model.set(this.statusKey, 'off');
    this.model.set(this.urlKey, instanceUrl);
    this.model.set(this.validationIntervalKey, validationInterval);
    this.model.set(this.glideSessionStoreKey, null);

    this.workerPage = null;
    this.lastSuccessfulFetchPage = null;
    this.pagesWithLoadListener = new WeakSet();
    this.browserTargetCreatedHandler = null;
    this.healthCheckInFlight = false;

    this._ensureConnKey();
    if (this.healthChecker && typeof this.healthChecker.setCheckProvider === 'function') {
      this.healthChecker.setCheckProvider(this._runHealthScenario.bind(this));
    }

    this.initializationPromise = this._initializeBrowser();
  }

  async _initializeBrowser() {
    try {
      const provider = this.browserProvider;
      let browser = provider && typeof provider.getBrowser === 'function' ? provider.getBrowser() : null;
      const connected = browser && typeof browser.isConnected === 'function' && browser.isConnected();
      if (!connected && provider && typeof provider.launch === 'function') {
        await provider.launch({ initialUrl: this._getHealthUrlForKey(this._ensureConnKey()) || undefined });
        browser = provider.getBrowser();
      }
      await this._attachBrowserLoadListeners(browser);
      const pages = await this._getOpenPages();
      if (pages[0]) {
        this.workerPage = pages[0];
        await this._handlePageLoad(pages[0]);
      }
    } catch (e) {
      // Lazy retries happen through connect/health/consumer fetch flows.
    }
  }

  async ready() {
    await this._ensureInitialized();
  }

  async _ensureInitialized() {
    if (this.initializationPromise) {
      await this.initializationPromise;
    }
  }

  isOn() {
    return this.model.get(this.statusKey) === 'on';
  }

  getBaseURL() {
    const url = this.model.get(this.urlKey);
    return typeof url === 'string' && url ? url : null;
  }

  _markOn() {
    if (!this.isOn()) {
      this.model.set(this.statusKey, 'on');
    }
    this.model.set(this.lastActivityKey, Date.now());
    if (this.healthChecker && typeof this.healthChecker.startPeriodicCheck === 'function') {
      this.healthChecker.startPeriodicCheck();
    }
  }

  _markOff() {
    this.model.set(this.statusKey, 'off');
    if (this.healthChecker && typeof this.healthChecker.stopPeriodicCheck === 'function') {
      Promise.resolve(this.healthChecker.stopPeriodicCheck()).catch(() => {});
    }
  }

  _ensureConnKey() {
    if (this.healthChecker && typeof this.healthChecker.ensureConnKey === 'function') {
      const key = this.healthChecker.ensureConnKey();
      if (typeof key === 'string' && key && this.model.get(this.connKeyKey) !== key) {
        this.model.set(this.connKeyKey, key);
      }
      if (typeof key === 'string' && key) {
        return key;
      }
    }
    const existing = this.model.get(this.connKeyKey);
    if (typeof existing === 'string' && existing) {
      return existing;
    }
    const generated = randomUUID();
    this.model.set(this.connKeyKey, generated);
    return generated;
  }

  _rotateConnKey() {
    if (this.healthChecker && typeof this.healthChecker.rotateConnKey === 'function') {
      return this.healthChecker.rotateConnKey();
    }
    return null;
  }

  _getHealthUrlForKey(connKey) {
    if (!connKey) {
      return null;
    }
    return buildHealthCheckUrl(this.getBaseURL(), connKey);
  }

  _isSuccessForKey(url, connKey) {
    const suffix = buildSuccessSuffix(connKey);
    return pathEndsWithSuccessSuffix(url, suffix);
  }

  _isSuccessByFetchEvidence(result, connKey) {
    if (result && this._isSuccessForKey(result.finalUrl, connKey)) {
      return true;
    }
    const successTarget = `ws_blank_page.do?${connKey}`;
    const encodedTarget = encodeURIComponent(successTarget);
    const finalUrl = result && typeof result.finalUrl === 'string' ? result.finalUrl : '';
    if (finalUrl.includes(successTarget) || finalUrl.includes(encodedTarget)) {
      return true;
    }
    const body = result && typeof result.body === 'string' ? result.body : '';
    if (!body) {
      return false;
    }
    // Real nav_to flows may return HTML/JS redirect rather than HTTP redirects.
    // Treat that as success when redirect evidence contains both ws_blank_page and current key.
    if (!body.includes('ws_blank_page.do')) {
      return false;
    }
    return body.includes(connKey) || body.includes(encodeURIComponent(connKey));
  }

  _applySuccessForKey(connKey) {
    const current = this.model.get(this.connKeyKey);
    if (current !== connKey) {
      if (!this.isOn()) {
        this._markOn();
      }
      return true;
    }
    this._markOn();
    this._rotateConnKey();
    return true;
  }

  async _getBrowser() {
    const provider = this.browserProvider;
    const browser = provider && typeof provider.getBrowser === 'function' ? provider.getBrowser() : null;
    if (!browser || typeof browser.isConnected !== 'function' || !browser.isConnected()) {
      return null;
    }
    return browser;
  }

  async _getOpenPages() {
    const browser = await this._getBrowser();
    if (!browser || typeof browser.pages !== 'function') {
      return [];
    }
    return browser.pages().catch(() => []);
  }

  _extractHostname(url) {
    if (!url || typeof url !== 'string') {
      return null;
    }
    try {
      return new URL(url).hostname;
    } catch (e) {
      return null;
    }
  }

  _extractPathname(url) {
    if (!url || typeof url !== 'string') {
      return null;
    }
    try {
      return new URL(url).pathname;
    } catch (e) {
      return null;
    }
  }

  _extractInstanceDomain() {
    return this._extractHostname(this.getBaseURL());
  }

  _resolveInstanceFetchUrl(inputUrl) {
    if (typeof inputUrl !== 'string' || inputUrl.length === 0) {
      throw new Error('fetch URL must be a non-empty string');
    }
    // Reject absolute URLs by syntax (scheme present).
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(inputUrl)) {
      throw new Error('fetch URL must be relative; absolute URLs are not allowed');
    }
    const path = inputUrl.startsWith('/') ? inputUrl : `/${inputUrl}`;
    const base = this.getBaseURL();
    if (!base) {
      throw new Error('Connection base URL is not configured');
    }
    return `${base.replace(/\/+$/, '')}${path}`;
  }

  _getInstanceGck() {
    const domain = this._extractInstanceDomain();
    if (!domain) {
      return null;
    }
    const gcks = this.model.get('browser_g_cks') || {};
    const token = gcks && typeof gcks === 'object' ? gcks[domain] : null;
    return typeof token === 'string' && token ? token : null;
  }

  _hasHeader(headers, name) {
    if (!headers || typeof headers !== 'object') {
      return false;
    }
    const target = String(name).toLowerCase();
    return Object.keys(headers).some((key) => String(key).toLowerCase() === target);
  }

  _withDefaultUserTokenHeader(options = {}) {
    const next = { ...options };
    const headers = options.headers && typeof options.headers === 'object'
      ? { ...options.headers }
      : {};
    if (!this._hasHeader(headers, 'X-UserToken')) {
      const gck = this._getInstanceGck();
      if (!gck) {
        throw new Error('Missing g_ck for instance; cannot set X-UserToken');
      }
      headers['X-UserToken'] = gck;
    }
    next.headers = headers;
    return next;
  }

  _isPageOpen(page) {
    return !!page && (typeof page.isClosed !== 'function' || !page.isClosed());
  }

  _isPageOnInstanceFqdn(page) {
    if (!this._isPageOpen(page) || typeof page.url !== 'function') {
      return false;
    }
    return this._extractHostname(page.url()) === this._extractHostname(this.getBaseURL());
  }

  _isPageBlankHealth(page) {
    if (!this._isPageOnInstanceFqdn(page) || typeof page.url !== 'function') {
      return false;
    }
    const pathname = this._extractPathname(page.url());
    return typeof pathname === 'string' && pathname.endsWith(BLANK_PATH_SUFFIX);
  }

  _isPageSafeNavigationTarget(page) {
    if (!this._isPageOnInstanceFqdn(page) || typeof page.url !== 'function') {
      return false;
    }
    const pathname = this._extractPathname(page.url());
    return typeof pathname === 'string' && SAFE_NAV_PATHS.has(pathname);
  }

  async _selectFetchableTab() {
    if (this._isPageOnInstanceFqdn(this.lastSuccessfulFetchPage)) {
      this._attachPageLoadListener(this.lastSuccessfulFetchPage);
      return this.lastSuccessfulFetchPage;
    }
    const pages = await this._getOpenPages();
    const selected = pages.find((page) => this._isPageOnInstanceFqdn(page)) || null;
    if (selected) {
      this._attachPageLoadListener(selected);
    }
    return selected;
  }

  async _selectNavigationTabOrCreate() {
    const pages = await this._getOpenPages();
    const safeTarget = pages.find((page) => this._isPageSafeNavigationTarget(page));
    if (safeTarget) {
      this._attachPageLoadListener(safeTarget);
      return safeTarget;
    }
    const selected = pages.find((page) => this._isPageBlankHealth(page));
    if (selected) {
      this._attachPageLoadListener(selected);
      return selected;
    }
    const browser = await this._getBrowser();
    if (!browser || typeof browser.newPage !== 'function') {
      return null;
    }
    const page = await browser.newPage();
    this._attachPageLoadListener(page);
    if (!this.workerPage || (typeof this.workerPage.isClosed === 'function' && this.workerPage.isClosed())) {
      this.workerPage = page;
    }
    return page;
  }

  async _fetchOnPage(page, url, options = {}) {
    const init = {
      method: (options.method || 'GET').toUpperCase(),
      headers: options.headers && typeof options.headers === 'object' ? options.headers : {},
      body: options.body != null ? String(options.body) : undefined,
    };
    const result = await page.evaluate(
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
    this.lastSuccessfulFetchPage = page;
    return result;
  }

  async _attemptHealthFetch(connKey) {
    const page = await this._selectFetchableTab();
    if (!page) {
      return { fetchable: false, success: false };
    }
    const healthUrl = this._getHealthUrlForKey(connKey);
    if (!healthUrl) {
      return { fetchable: true, success: false };
    }
    try {
      const result = await this._fetchOnPage(page, healthUrl, { method: 'GET' });
      return { fetchable: true, success: this._isSuccessByFetchEvidence(result, connKey) };
    } catch (e) {
      return { fetchable: true, success: false };
    }
  }

  async _provisionNavigationAndCheck(connKey) {
    const page = await this._selectNavigationTabOrCreate();
    if (!page) {
      return false;
    }
    const healthUrl = this._getHealthUrlForKey(connKey);
    if (!healthUrl) {
      return false;
    }
    try {
      await page.goto(healthUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this._syncPageGck(page);
      const pageUrl = typeof page.url === 'function' ? page.url() : null;
      if (this._isSuccessForKey(pageUrl, connKey)) {
        this.lastSuccessfulFetchPage = page;
        return true;
      }
      // Success may already have been consumed by a load listener that rotated the key.
      return this.model.get(this.connKeyKey) !== connKey && this.isOn();
    } catch (e) {
      return false;
    }
  }

  async _runConnectScenario() {
    const connKey = this._ensureConnKey();
    const fetchOutcome = await this._attemptHealthFetch(connKey);
    if (fetchOutcome.fetchable && fetchOutcome.success) {
      return this._applySuccessForKey(connKey);
    }
    const navSuccess = await this._provisionNavigationAndCheck(connKey);
    if (navSuccess) {
      return this._applySuccessForKey(connKey);
    }
    return false; // keep OFF + preserve key
  }

  async _runHealthScenario() {
    if (this.healthCheckInFlight) {
      return this.isOn();
    }
    this.healthCheckInFlight = true;
    try {
      const connKey = this._ensureConnKey();
      const fetchOutcome = await this._attemptHealthFetch(connKey);
      if (fetchOutcome.fetchable) {
        if (fetchOutcome.success) {
          this._applySuccessForKey(connKey); // keep ON + rotate key
          return true;
        }
        this._markOff();
        this._rotateConnKey(); // mark OFF + rotate key
        return false;
      }

      const navSuccess = await this._provisionNavigationAndCheck(connKey);
      if (navSuccess) {
        this._applySuccessForKey(connKey); // keep ON + rotate key
        return true;
      }
      this._markOff();
      this._rotateConnKey(); // mark OFF + rotate key
      return false;
    } finally {
      this.healthCheckInFlight = false;
    }
  }

  async _attachBrowserLoadListeners(browser) {
    if (!browser || typeof browser.pages !== 'function') {
      return;
    }
    const pages = await browser.pages().catch(() => []);
    for (const page of pages) {
      this._attachPageLoadListener(page);
    }
    if (!this.browserTargetCreatedHandler && typeof browser.on === 'function') {
      this.browserTargetCreatedHandler = async (target) => {
        try {
          const page = await target.page();
          if (!page) {
            return;
          }
          this._attachPageLoadListener(page);
          await this._handlePageLoad(page);
        } catch (e) {
          // ignore
        }
      };
      browser.on('targetcreated', this.browserTargetCreatedHandler);
    }
  }

  _attachPageLoadListener(page) {
    if (!page || this.pagesWithLoadListener.has(page) || typeof page.on !== 'function') {
      return;
    }
    page.on('load', () => {
      this._handlePageLoad(page).catch(() => {});
    });
    this.pagesWithLoadListener.add(page);
  }

  async _syncPageGck(page) {
    await syncGckForPage(page, this.model);
  }

  async _syncGlideSessionStore(page) {
    if (!this._isPageOnInstanceFqdn(page) || typeof page.cookies !== 'function') {
      return;
    }
    const previous = this.model.get(this.glideSessionStoreKey);
    let nextValue = null;
    try {
      const cookies = await page.cookies();
      if (Array.isArray(cookies)) {
        const target = cookies.find((cookie) => cookie && cookie.name === 'glide_session_store');
        if (target && target.value != null && String(target.value).length > 0) {
          nextValue = String(target.value);
        }
      }
    } catch (e) {
      return;
    }
    this.model.set(this.glideSessionStoreKey, nextValue);
    if (previous !== nextValue && this.isOn()) {
      this._triggerHealthCheckFromCookieChange();
    }
  }

  _triggerHealthCheckFromCookieChange() {
    this._runHealthScenario().catch(() => {});
  }

  async _handlePageLoad(page) {
    await this._syncPageGck(page);
    await this._syncGlideSessionStore(page);
    const connKey = this.model.get(this.connKeyKey);
    const pageUrl = page && typeof page.url === 'function' ? page.url() : null;
    if (!this._isSuccessForKey(pageUrl, connKey)) {
      return;
    }
    this.lastSuccessfulFetchPage = page;
    this._applySuccessForKey(connKey);
  }

  async getWorkerPage() {
    await this._ensureInitialized();
    if (!this.isOn()) {
      return null;
    }
    const page = await this._selectFetchableTab();
    this.workerPage = page || this.workerPage;
    return page;
  }

  async reset() {
    await this._ensureInitialized();
    const connKey = this._ensureConnKey();
    await this._provisionNavigationAndCheck(connKey);
  }

  async connect() {
    await this._ensureInitialized();
    if (this.isOn()) {
      return true;
    }
    return this._runConnectScenario();
  }

  async fetch(url, options = {}) {
    await this._ensureInitialized();
    if (!this.isOn()) {
      throw new Error('Connection is off');
    }
    const resolvedUrl = this._resolveInstanceFetchUrl(url);
    const normalizedOptions = this._withDefaultUserTokenHeader(options);

    let page = await this._selectFetchableTab();
    if (!page) {
      const connKey = this._ensureConnKey();
      const navSuccess = await this._provisionNavigationAndCheck(connKey);
      if (!navSuccess) {
        this._markOff();
        this._rotateConnKey();
        throw new Error('No fetchable tab available and navigation provisioning landed off-suffix');
      }
      this._applySuccessForKey(connKey); // keep ON + rotate key
      page = await this._selectFetchableTab();
      if (!page) {
        throw new Error('No fetchable tab available after successful navigation provisioning');
      }
    }

    const result = await this._fetchOnPage(page, resolvedUrl, normalizedOptions);
    this.model.set(this.lastActivityKey, Date.now());
    return result;
  }

  disconnect() {
    this._markOff();
    this._rotateConnKey();
  }
}

module.exports = { Connection };
