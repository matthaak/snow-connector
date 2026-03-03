/**
 * Syncs g_ck values from Puppeteer into the model on each page load (all tabs, all domains).
 * - g_ck: domain -> detected g_ck value → browser_g_cks (only set or update; never remove or nullify).
 *
 * No interval; updates are driven by the browser 'load' event.
 */

const { getBrowserProvider, getModelProvider } = require('./providers.js');
const { extractFqdn, getGckFromPage, syncGckForPage } = require('./gckSync.js');

/**
 * On a single page load: if g_ck is present, update browser_g_cks for this page's domain.
 * @param {import('puppeteer').Page} page
 * @param {Object} model
 * @param {{ stopped: boolean }} state
 */
async function handlePageLoad(page, model, state) {
  if (state.stopped) return;
  await syncGckForPage(page, model);
}

/**
 * Start syncing browser state to the model on each page load. No interval; updates
 * when any tab fires the 'load' event. Only browser_g_cks is updated.
 * New tabs get the same listener when created.
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
