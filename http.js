/**
 * Global HTTP utilities.
 * httpGet follows redirects and can use the model to add Cookie and X-UserToken (g_ck) by URL hostname.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { getModelProvider } = require('./providers.js');

const MAX_REDIRECTS = 10;

/**
 * Resolve Cookie and X-UserToken for a URL from the model (browser_cookies and browser_g_cks by hostname).
 * If not found for the domain, the corresponding header is omitted.
 * @param {string} url - The URL (used to get hostname)
 * @param {string} [explicitCookie] - If provided, use this as Cookie and do not look up cookie from model
 * @returns {{ cookie: string|undefined, userToken: string|undefined }}
 */
function getHeadersFromModel(url, explicitCookie) {
  let cookie = explicitCookie && typeof explicitCookie === 'string' ? explicitCookie.trim() : undefined;
  let userToken;
  try {
    const parsed = new URL(url);
    const fqdn = parsed.hostname;
    if (!fqdn) return { cookie: cookie || undefined, userToken: undefined };
    const model = getModelProvider().getModel();
    if (!model) return { cookie: cookie || undefined, userToken: undefined };
    if (!cookie) {
      const cookiesObj = model.get('browser_cookies');
      if (cookiesObj && typeof cookiesObj === 'object' && cookiesObj[fqdn]) {
        const v = cookiesObj[fqdn];
        if (typeof v === 'string' && v.trim()) cookie = v.trim();
      }
    }
    const gCksObj = model.get('browser_g_cks');
    if (gCksObj && typeof gCksObj === 'object' && gCksObj[fqdn]) {
      const v = gCksObj[fqdn];
      if (typeof v === 'string' && v.trim()) userToken = v.trim();
    }
  } catch (e) {
    // ignore
  }
  return { cookie: cookie || undefined, userToken };
}

/**
 * Performs an HTTP GET that follows redirects.
 * Cookie and X-UserToken (g_ck) are resolved from the model by the URL's hostname when not passed.
 * @param {string} url - The URL to request
 * @param {string} [cookie] - Optional explicit cookie string (Cookie header). If omitted, looked up from model browser_cookies by url hostname.
 * @returns {Promise<{ statusCode: number, finalUrl: string }>} Resolves with final status and URL after redirects; rejects on error
 */
function httpGet(url, cookie) {
  return new Promise((resolve, reject) => {
    let redirectCount = 0;

    function request(targetUrl) {
      let parsed;
      try {
        parsed = new URL(targetUrl);
      } catch (e) {
        reject(new Error(`Invalid URL: ${targetUrl}`));
        return;
      }

      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {},
        rejectUnauthorized: true,
      };

      const headerSource = getHeadersFromModel(targetUrl, cookie);
      if (headerSource.cookie) {
        options.headers['Cookie'] = headerSource.cookie;
      }
      if (headerSource.userToken) {
        options.headers['X-UserToken'] = headerSource.userToken;
      }

      const req = lib.request(options, (res) => {
        const statusCode = res.statusCode || 0;
        const location = res.headers.location;

        if (statusCode >= 300 && statusCode < 400 && location) {
          redirectCount++;
          if (redirectCount > MAX_REDIRECTS) {
            reject(new Error(`Too many redirects (${MAX_REDIRECTS})`));
            return;
          }
          try {
            const nextUrl = new URL(location, targetUrl).href;
            request(nextUrl);
          } catch (e) {
            reject(e);
          }
          return;
        }

        // Consume response body so the connection can close (we only care about final URL and status)
        res.resume();
        resolve({ statusCode, finalUrl: targetUrl });
      });

      req.on('error', reject);
      req.end();
    }

    request(url);
  });
}

module.exports = {
  httpGet,
};
