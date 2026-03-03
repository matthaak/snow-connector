const BROWSER_G_CKS_KEY = 'browser_g_cks';

function extractFqdn(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }
  try {
    return new URL(url).hostname;
  } catch (e) {
    const match = url.match(/https?:\/\/([^/]+)/);
    return match ? match[1] : null;
  }
}

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

async function syncGckForPage(page, model, key = BROWSER_G_CKS_KEY) {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed()) || !model) {
    return;
  }
  const url = typeof page.url === 'function' ? page.url() : null;
  const fqdn = extractFqdn(url);
  if (!fqdn) {
    return;
  }
  const gck = await getGckFromPage(page);
  if (gck == null) {
    return;
  }
  const current = model.get(key) || {};
  model.set(key, { ...current, [fqdn]: gck });
}

module.exports = {
  BROWSER_G_CKS_KEY,
  extractFqdn,
  getGckFromPage,
  syncGckForPage,
};
