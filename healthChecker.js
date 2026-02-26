/**
 * Health checker for ServiceNow instance.
 * Health checks run through the connection's worker fetch process, and periodic checks
 * run at the connection's validation interval.
 * Success = final URL path ends with SUCCESS_PATH_SUFFIX; otherwise connection is reported down.
 * On success, updates ${id}_last_activity.
 */

const { getModelProvider } = require('./providers.js');

const HEALTH_PATH = '/nav_to.do?uri=sys.scripts.do';
const SUCCESS_PATH_SUFFIX = 'sys.scripts.do';

function extractFqdn(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch (e) {
    const match = url.match(/https?:\/\/([^/]+)/);
    return match ? match[1] : null;
  }
}

function buildHealthCheckUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') {
    return null;
  }
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${HEALTH_PATH.startsWith('/') ? '' : '/'}${HEALTH_PATH}`;
}

function pathEndsWithSuccessSuffix(finalUrl) {
  if (!finalUrl || typeof finalUrl !== 'string') {
    return false;
  }
  try {
    const pathname = new URL(finalUrl).pathname;
    return pathname.endsWith(SUCCESS_PATH_SUFFIX);
  } catch (e) {
    return false;
  }
}

class HealthChecker {
  constructor(id) {
    this.id = id;
    this.model = getModelProvider().getModel();
    this.workerPageProvider = null;
    this.workerFetchProvider = null;
    this.periodicTimer = null;
  }

  setWorkerPageProvider(fn) {
    this.workerPageProvider = typeof fn === 'function' ? fn : null;
  }

  setWorkerFetchProvider(fn) {
    this.workerFetchProvider = typeof fn === 'function' ? fn : null;
  }

  _getHealthUrl() {
    const url = this.model.get(`${this.id}_url`);
    return buildHealthCheckUrl(url);
  }

  _getValidationInterval() {
    return this.model.get(`${this.id}_validationInterval`) || 0;
  }

  _getStatusKey() {
    return `${this.id}_conn_status`;
  }

  _getLastActivityKey() {
    return `${this.id}_last_activity`;
  }

  /**
   * Ensures the worker tab exists and is on the health URL (login page when signed out).
   * Call at startup so the user has one tab to log in on; doCheck() uses the same tab.
   * @returns {Promise<boolean>} true if tab is open and navigated
   */
  async ensureHealthTab() {
    const healthUrl = this._getHealthUrl();
    if (!healthUrl || typeof this.workerPageProvider !== 'function') {
      return false;
    }
    try {
      const page = await this.workerPageProvider();
      if (!page || page.isClosed()) {
        return false;
      }
      await page.goto(healthUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Runs a health check through the worker fetch process.
   * @returns {Promise<boolean>} true if health check passed, false otherwise
   */
  async doCheck() {
    const healthUrl = this._getHealthUrl();
    if (!healthUrl || typeof this.workerFetchProvider !== 'function') {
      return false;
    }
    try {
      const response = await this.workerFetchProvider(healthUrl, { method: 'GET' }, {
        requireOn: false,
      });
      const finalUrl = response && typeof response.finalUrl === 'string'
        ? response.finalUrl
        : null;
      let ok = pathEndsWithSuccessSuffix(finalUrl);

      // Some instances rely on full-page navigation/redirect handling that fetch() may not reflect.
      // Fallback to managed page navigation to determine effective final URL.
      if (!ok && typeof this.workerPageProvider === 'function') {
        try {
          const page = await this.workerPageProvider();
          if (page && !page.isClosed()) {
            await page.goto(healthUrl, {
              waitUntil: 'load',
              timeout: 30000,
            });
            ok = pathEndsWithSuccessSuffix(page.url());
          }
        } catch (e) {
          // ignore fallback errors; keep previous result
        }
      }
      if (ok) {
        this.model.set(this._getLastActivityKey(), Date.now());
      } else {
        this.model.set(this._getStatusKey(), 'off');
      }
      return ok;
    } catch (e) {
      this.model.set(this._getStatusKey(), 'off');
      return false;
    }
  }

  /**
   * Starts the periodic health check via worker fetch at validationInterval.
   * Call after connection is on.
   */
  startPeriodicCheck() {
    this.stopPeriodicCheck();
    const interval = this._getValidationInterval();
    if (!interval) {
      return;
    }
    this.periodicTimer = setInterval(() => {
      if (this.model.get(this._getStatusKey()) !== 'on') {
        this.stopPeriodicCheck();
        return;
      }
      this.doCheck().catch(() => {});
    }, interval);
  }

  /**
   * Stops the periodic health check timer.
   */
  async stopPeriodicCheck() {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }
}

module.exports = {
  HealthChecker,
  extractFqdn,
  buildHealthCheckUrl,
  pathEndsWithSuccessSuffix,
  HEALTH_PATH,
  SUCCESS_PATH_SUFFIX,
};
