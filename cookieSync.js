/**
 * Syncs cookies from the Puppeteer browser (all tabs, all domains) into the model.
 * Writes the same full map (domain -> cookie string) to ${id}_browser_cookies for
 * each connection id. Connection is alerted to all cookies and matches to its own
 * domain (urlFqdn). Uses CDP when available (Chrome/Chromium) for HttpOnly cookies;
 * falls back to page.cookies() per tab (e.g. Firefox).
 */

const { getBrowserProvider, getModelProvider } = require('./providers.js');

function extractFqdn(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    return new URL(url).hostname;
  } catch (e) {
    const match = url.match(/https?:\/\/([^/]+)/);
    return match ? match[1] : null;
  }
}

/**
 * Format CDP cookie or Puppeteer Cookie as "name=value" for the cookie header.
 */
function formatCookieString(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return '';
  return cookies.map((c) => `${c.name}=${c.value || ''}`).join('; ');
}

/**
 * Build domain -> cookie string from CDP cookies (all cookies in browser).
 */
function buildDomainToCookieStringFromCdp(cookies) {
  const byDomain = Object.create(null);
  for (const c of cookies) {
    const domain = c.domain || '';
    if (!byDomain[domain]) byDomain[domain] = [];
    byDomain[domain].push(c);
  }
  const result = Object.create(null);
  for (const [domain, list] of Object.entries(byDomain)) {
    result[domain] = formatCookieString(list);
  }
  return result;
}

/**
 * For a given hostname, get the cookie string from domain->cookieString map.
 * Combines exact domain and leading-dot domain (e.g. .service-now.com).
 */
function getCookieStringForHost(domainToCookieString, hostname) {
  const parts = [];
  if (domainToCookieString[hostname]) {
    parts.push(domainToCookieString[hostname]);
  }
  for (const [domain, cookieString] of Object.entries(domainToCookieString)) {
    if (domain.startsWith('.') && (hostname === domain.slice(1) || hostname.endsWith(domain))) {
      parts.push(cookieString);
    }
  }
  return parts.join('; ');
}

/**
 * One sync pass: read ALL cookies from the browser (all tabs, all domains),
 * build a single domain -> cookie string map, and set it for each connection id.
 * Connection is alerted to the full map and matches to its own domain (urlFqdn).
 * @param {import('puppeteer').Browser} browser
 * @param {Object} model - model-manager model
 * @param {number[]} connectionIds - e.g. [0]
 */
async function syncCookiesOnce(browser, model, connectionIds) {
  let domainToCookieString = Object.create(null);

  const pages = await browser.pages();
  if (pages.length === 0) return;

  const firstPage = pages[0];

  try {
    const cdp = await firstPage.target().createCDPSession();
    await cdp.send('Network.enable');
    const { cookies } = await cdp.send('Network.getAllCookies');
    await cdp.detach();
    domainToCookieString = buildDomainToCookieStringFromCdp(cookies);
  } catch (e) {
    // CDP not available (e.g. Firefox); use page.cookies() per page (all tabs)
    for (const page of pages) {
      try {
        const url = page.url();
        const fqdn = extractFqdn(url);
        if (!fqdn) continue;
        const cookies = await page.cookies();
        if (domainToCookieString[fqdn]) {
          domainToCookieString[fqdn] =
            domainToCookieString[fqdn] + '; ' + formatCookieString(cookies);
        } else {
          domainToCookieString[fqdn] = formatCookieString(cookies);
        }
      } catch (err) {
        // Skip this page
      }
    }
  }

  // Collect all hostnames: from every tab URL, every connection URL, and CDP cookie domains
  const hostnames = new Set();
  for (const page of pages) {
    const fqdn = extractFqdn(page.url());
    if (fqdn) hostnames.add(fqdn);
  }
  for (const id of connectionIds) {
    const fqdn = extractFqdn(model.get(`${id}_url`));
    if (fqdn) hostnames.add(fqdn);
  }
  for (const domain of Object.keys(domainToCookieString)) {
    if (domain && !domain.startsWith('.')) hostnames.add(domain);
  }

  // Build one full map: hostname -> cookie string (so Connection can look up its urlFqdn)
  const fullMap = Object.create(null);
  for (const hostname of hostnames) {
    const cookieString = getCookieStringForHost(domainToCookieString, hostname);
    fullMap[hostname] = cookieString;
  }

  // Set the same full map for each connection id; Connection gets alerted and matches to its domain
  for (const id of connectionIds) {
    model.set(`${id}_browser_cookies`, fullMap);
  }
}

/**
 * Start syncing cookies from the browser to the model every intervalMs.
 * @param {number[]} connectionIds - e.g. [0]
 * @param {number} [intervalMs=2000]
 * @returns {{ stop: function }} - call stop() to clear the interval
 */
function startCookieSync(connectionIds, intervalMs = 2000) {
  const browser = getBrowserProvider().getBrowser();
  const model = getModelProvider().getModel();
  if (!browser || !model) return { stop: () => {} };

  const interval = setInterval(() => {
    if (!browser.isConnected()) {
      clearInterval(interval);
      return;
    }
    syncCookiesOnce(browser, model, connectionIds).catch(() => {});
  }, intervalMs);

  return {
    stop() {
      clearInterval(interval);
    },
  };
}

module.exports = {
  startCookieSync,
  syncCookiesOnce,
  extractFqdn,
};
