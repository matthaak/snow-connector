const { model } = require('observable-state-model');

let modelProvider = { getModel() { return model; } };

/**
 * Returns true if the given executable path is for Firefox (by name).
 * @param {string} executablePath - Path to browser executable
 * @returns {boolean}
 */
function isFirefoxPath(executablePath) {
  if (!executablePath || typeof executablePath !== 'string') return false;
  const lower = executablePath.toLowerCase();
  return lower.includes('firefox') || lower.includes('mozilla');
}

/**
 * Default browser provider: singleton that launches Chromium/Chrome or Firefox
 * based on the executable path set via setExecutablePath, or SNOW_CONNECTOR_BROWSER env var.
 * If neither is set, Puppeteer's bundled Chromium is used.
 * Supports persistent profiles and password saving/recall.
 */
function createDefaultBrowserProvider() {
  let browserInstance = null;
  let executablePath = process.env.SNOW_CONNECTOR_BROWSER || null;

  return {
    getBrowser() {
      return browserInstance;
    },

    setExecutablePath(path) {
      executablePath = path;
    },

    async launch(options = {}) {
      if (browserInstance && browserInstance.isConnected()) {
        return browserInstance;
      }

      const wrapper = isFirefoxPath(executablePath)
        ? require('./browser-wrapper-firefox.js')
        : require('./browser-wrapper.js');

      const launchOptions = {
        executablePath: executablePath || undefined,
        initialUrl: options.initialUrl,
        userDataDir: options.userDataDir,
        headless: options.headless,
      };

      browserInstance = await wrapper.launch(launchOptions);
      return browserInstance;
    },
  };
}

let browserProvider = createDefaultBrowserProvider();
let healthCheckerFactory = {
  create(id) {
    const { HealthChecker } = require('./healthChecker.js');
    return new HealthChecker(id);
  },
};

function setModelProvider(provider) {
  modelProvider = provider;
}

function setBrowserProvider(provider) {
  browserProvider = provider;
}

function setHealthCheckerFactory(factory) {
  healthCheckerFactory = factory;
}

function getModelProvider() {
  return modelProvider;
}

function getBrowserProvider() {
  return browserProvider;
}

function getHealthCheckerFactory() {
  return healthCheckerFactory;
}

module.exports = {
  setModelProvider,
  setBrowserProvider,
  setHealthCheckerFactory,
  getModelProvider,
  getBrowserProvider,
  getHealthCheckerFactory,
  createDefaultBrowserProvider,
  isFirefoxPath,
};
