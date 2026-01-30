/**
 * Real health checker for ServiceNow instance.
 * Checks /nav_to.do?uri=sys.scripts.do, follows redirects; success = final path ends with "sys.scripts.do".
 * Uses cookies from ${id}_browser_cookies for the target domain; fails immediately if none.
 * On success, updates ${id}_last_activity.
 */

const { httpGet } = require('./http.js');
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
  }

  /**
   * Performs health check for the connection (uses id from constructor).
   * @returns {Promise<boolean>} true if health check passed, false otherwise
   */
  async doCheck() {
    const id = this.id;
    const cookiesKey = `${id}_browser_cookies`;
    const urlKey = `${id}_url`;
    const lastActivityKey = `${id}_last_activity`;

    const cookiesObj = this.model.get(cookiesKey);
    if (!cookiesObj || typeof cookiesObj !== 'object' || cookiesObj === null) {
      return false;
    }

    const url = this.model.get(urlKey);
    const fqdn = extractFqdn(url);
    if (!fqdn) {
      return false;
    }

    const cookie = cookiesObj[fqdn];
    if (!cookie || typeof cookie !== 'string') {
      return false;
    }

    const healthUrl = buildHealthCheckUrl(url);
    if (!healthUrl) {
      return false;
    }

    try {
      const { finalUrl } = await httpGet(healthUrl, cookie);
      const ok = pathEndsWithSuccessSuffix(finalUrl);
      if (ok) {
        this.model.set(lastActivityKey, Date.now());
      }
      return ok;
    } catch (e) {
      return false;
    }
  }
}

module.exports = {
  HealthChecker,
  extractFqdn,
  buildHealthCheckUrl,
  pathEndsWithSuccessSuffix,
};
