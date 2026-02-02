/**
 * Syncs browser state from Puppeteer into the model on each page load (all tabs, all domains).
 * - Cookies: domain -> cookie string → browser_cookies (only the loaded page's domain is updated).
 * - g_ck: domain -> detected g_ck value → browser_g_cks (only set or update; never remove or nullify).
 *
 * No interval; updates are driven by the browser 'load' event. Closing the last tab for a domain
 * leaves that domain's entries in the model (they become stale); this is acceptable.
 */

const { getBrowserProvider, getModelProvider } = require('./providers.js');

const BROWSER_COOKIES_KEY = 'browser_cookies';
const BROWSER_G_CKS_KEY = 'browser_g_cks';

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
 * Format Puppeteer Cookie array as "name=value" for the cookie header.
 */
function formatCookieString(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return '';
  return cookies.map((c) => `${c.name}=${c.value || ''}`).join('; ');
}

/**
 * Evaluate g_ck / window.g_ck in the page context. Returns serializable value or null.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<string|null>}
 */
async function getGckFromPage(page) {
  try {
    const value = await page.evaluate(() => {
      try {
        if (typeof window !== 'undefined' && typeof window.g_ck !== 'undefined') {
          const v = window.g_ck;
          return v != null ? String(v) : null;
        }
        if (typeof globalThis !== 'undefined' && typeof globalThis.g_ck !== 'undefined') {
          const v = globalThis.g_ck;
          return v != null ? String(v) : null;
        }
        if (typeof g_ck !== 'undefined') {
          const v = g_ck;
          return v != null ? String(v) : null;
        }
        return null;
      } catch (e) {
        return null;
      }
    });
    return value && typeof value === 'string' ? value : null;
  } catch (e) {
    return null;
  }
}

/**
 * On a single page load: update only that page's domain in browser_cookies and,
 * if g_ck is present, in browser_g_cks. Never remove or nullify a g_ck value.
 * @param {import('puppeteer').Page} page
 * @param {Object} model
 * @param {{ stopped: boolean }} state
 */
async function handlePageLoad(page, model, state) {
  if (state.stopped) return;
  const url = page.url();
  const fqdn = extractFqdn(url);
  if (!fqdn) return;
  try {
    const cookies = await page.cookies();
    const cookieString = formatCookieString(cookies);
    const currentCookies = model.get(BROWSER_COOKIES_KEY) || {};
    model.set(BROWSER_COOKIES_KEY, { ...currentCookies, [fqdn]: cookieString });
  } catch (e) {
    // ignore
  }
  try {
    const gck = await getGckFromPage(page);
    if (gck != null) {
      const currentGcks = model.get(BROWSER_G_CKS_KEY) || {};
      model.set(BROWSER_G_CKS_KEY, { ...currentGcks, [fqdn]: gck });
    }
    // If gck is null, leave existing browser_g_cks entry for this domain unchanged (3b).
  } catch (e) {
    // ignore
  }
}

/**
 * Start syncing browser state to the model on each page load. No interval; updates
 * when any tab fires the 'load' event. Only the loaded page's domain is updated in
 * browser_cookies and browser_g_cks. New tabs get the same listener when created.
 * @returns {{ stop: function }} - call stop() to remove listeners and stop updates
 */
function startBrowserSync() {
  const browser = getBrowserProvider().getBrowser();
  const model = getModelProvider().getModel();
  if (!browser || !model) return { stop: () => {} };

  const state = { stopped: false };

  function onLoad(page) {
    if (state.stopped) return;
    handlePageLoad(page, model, state).catch(() => {});
  }

  const targetCreatedHandler = async (target) => {
    if (state.stopped) return;
    try {
      const page = await target.page();
      if (page) {
        page.on('load', () => onLoad(page));
        await handlePageLoad(page, model, state);
      }
    } catch (e) {
      // ignore
    }
  };

  browser.on('targetcreated', targetCreatedHandler);

  (async () => {
    const pages = await browser.pages();
    for (const page of pages) {
      if (state.stopped) return;
      page.on('load', () => onLoad(page));
      await handlePageLoad(page, model, state);
    }
  })();

  return {
    stop() {
      state.stopped = true;
      browser.off('targetcreated', targetCreatedHandler);
    },
  };
}

module.exports = {
  startBrowserSync,
  extractFqdn,
  getGckFromPage,
};
