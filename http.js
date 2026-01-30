/**
 * Global HTTP utilities.
 * httpGet follows redirects and supports an optional cookie header for the domain.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const MAX_REDIRECTS = 10;

/**
 * Performs an HTTP GET that follows redirects.
 * @param {string} url - The URL to request
 * @param {string} [cookie] - Optional full cookie string for the domain (Cookie header value)
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

      if (cookie && typeof cookie === 'string' && cookie.trim()) {
        options.headers['Cookie'] = cookie.trim();
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
