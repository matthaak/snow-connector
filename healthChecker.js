/**
 * Health checker for ServiceNow instance.
 * Health checks run through the connection's worker fetch process, and periodic checks
 * run at the connection's validation interval.
 * Success = final URL path ends with SUCCESS_PATH_SUFFIX; otherwise connection is reported down.
 * On success, updates ${id}_last_activity.
 */

const { getModelProvider } = require('./providers.js');
const { randomUUID } = require('crypto');

const HEALTH_TARGET_PATH = 'ws_blank_page.do';

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

function buildSuccessSuffix(connKey) {
  if (!connKey || typeof connKey !== 'string') {
    return null;
  }
  return `${HEALTH_TARGET_PATH}?${connKey}`;
}

function buildHealthCheckUrl(baseUrl, connKey) {
  if (!baseUrl || typeof baseUrl !== 'string') {
    return null;
  }
  const successSuffix = buildSuccessSuffix(connKey);
  if (!successSuffix) {
    return null;
  }
  const base = baseUrl.replace(/\/+$/, '');
  const encodedUri = encodeURIComponent(successSuffix);
  return `${base}/nav_to.do?uri=${encodedUri}`;
}

function pathEndsWithSuccessSuffix(finalUrl, successSuffix) {
  if (!finalUrl || typeof finalUrl !== 'string') {
    return false;
  }
  if (!successSuffix || typeof successSuffix !== 'string') {
    return false;
  }
  try {
    const parsed = new URL(finalUrl);
    const normalized = successSuffix.startsWith('/') ? successSuffix : `/${successSuffix}`;
    const qIdx = normalized.indexOf('?');
    if (qIdx < 0) {
      return `${parsed.pathname}${parsed.search}`.endsWith(normalized);
    }

    const expectedPath = normalized.slice(0, qIdx);
    const expectedKeyToken = normalized.slice(qIdx + 1);
    if (!parsed.pathname.endsWith(expectedPath)) {
      return false;
    }

    // Real ServiceNow pages may append extra query params. Treat success as:
    // same success path + query string containing the current key token.
    const query = parsed.search.startsWith('?') ? parsed.search.slice(1) : parsed.search;
    return query.split('&').some((part) => part === expectedKeyToken || part.startsWith(`${expectedKeyToken}=`));
  } catch (e) {
    return false;
  }
}

class HealthChecker {
  constructor(id) {
    this.id = id;
    this.model = getModelProvider().getModel();
    this.checkProvider = null;
    this.periodicTimer = null;
  }

  setCheckProvider(fn) {
    this.checkProvider = typeof fn === 'function' ? fn : null;
  }

  _getHealthUrl() {
    const connKey = this.ensureConnKey();
    const url = this.model.get(`${this.id}_url`);
    return buildHealthCheckUrl(url, connKey);
  }

  _getValidationInterval() {
    return this.model.get(`${this.id}_validationInterval`) || 0;
  }

  _getConnKeyKey() {
    return `${this.id}_conn_key`;
  }

  _getStatusKey() {
    return `${this.id}_conn_status`;
  }

  _getLastActivityKey() {
    return `${this.id}_last_activity`;
  }

  ensureConnKey() {
    const keyName = this._getConnKeyKey();
    const existing = this.model.get(keyName);
    if (typeof existing === 'string' && existing) {
      return existing;
    }
    const next = randomUUID();
    this.model.set(keyName, next);
    return next;
  }

  rotateConnKey() {
    const next = randomUUID();
    this.model.set(this._getConnKeyKey(), next);
    return next;
  }

  getCurrentSuccessSuffix() {
    const connKey = this.ensureConnKey();
    return buildSuccessSuffix(connKey);
  }

  isSuccessForCurrentKey(finalUrl) {
    return pathEndsWithSuccessSuffix(finalUrl, this.getCurrentSuccessSuffix());
  }

  getHealthUrl() {
    return this._getHealthUrl();
  }

  /**
   * Runs one health check.
   * @returns {Promise<boolean>} true if health check passed, false otherwise
   */
  async doCheck() {
    if (typeof this.checkProvider !== 'function') {
      return false;
    }
    try {
      return !!(await this.checkProvider());
    } catch (e) {
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
  buildSuccessSuffix,
  buildHealthCheckUrl,
  pathEndsWithSuccessSuffix,
  HEALTH_TARGET_PATH,
};
