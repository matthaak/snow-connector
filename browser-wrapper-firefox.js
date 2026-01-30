/**
 * Wrapper for Puppeteer-launched Firefox.
 * Uses a persistent profile directory so password saving and recall work.
 */

const puppeteer = require('puppeteer');
const { join } = require('path');
const { existsSync, mkdirSync, writeFileSync, readFileSync } = require('fs');
const os = require('os');

const PROFILE_DIR_NAME = '.snow_connector_firefox_profile';

/**
 * Get the Firefox profile directory path.
 * @returns {string} Path to the Firefox profile directory
 */
function getFirefoxProfileDir() {
  const platform = os.platform();
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error('LOCALAPPDATA environment variable not found');
    }
    const profileDir = join(localAppData, 'snow-connector', 'firefox-profile');
    if (!existsSync(profileDir)) {
      mkdirSync(profileDir, { recursive: true });
    }
    return profileDir;
  }
  const profileDir = join(os.homedir(), PROFILE_DIR_NAME);
  if (!existsSync(profileDir)) {
    mkdirSync(profileDir, { recursive: true });
  }
  return profileDir;
}

/**
 * Configure Firefox preferences to enable password saving.
 * @param {string} profileDir - Path to the Firefox profile directory
 */
function configureFirefoxPasswordSaving(profileDir) {
  const userJsPath = join(profileDir, 'user.js');
  let existingPrefs = '';
  if (existsSync(userJsPath)) {
    try {
      existingPrefs = readFileSync(userJsPath, 'utf8');
    } catch (error) {
      // Create new
    }
  }

  const passwordPrefs = `
user_pref("signon.rememberSignons", true);
user_pref("signon.autofillForms", true);
user_pref("signon.autofillForms.http", true);
user_pref("signon.userInputRequiredToCapture.enabled", false);
user_pref("signon.privateBrowsingCapture.enabled", true);
user_pref("signon.storeWhenAutocompleteOff", true);
`;

  if (!existingPrefs.includes('signon.rememberSignons')) {
    try {
      writeFileSync(userJsPath, existingPrefs + passwordPrefs, 'utf8');
    } catch (error) {
      // Non-fatal
    }
  }
}

/**
 * @param {Error} error
 * @returns {string}
 */
function formatFirefoxError(error) {
  let message = `Firefox launch error: ${error.message}`;
  if (error.message.includes('Code: 0') || error.message.includes('Failed to launch')) {
    message += '\n\nPuppeteer cannot connect to Firefox.';
    message += '\nPossible solutions: close all Firefox instances, use Chrome/Chromium, or update Firefox.';
  }
  return message;
}

/**
 * Launch Firefox.
 * @param {Object} [options] - Launch options
 * @param {string} [options.executablePath] - Path to Firefox executable; omit to let Puppeteer download Firefox
 * @param {string} [options.userDataDir] - Override profile directory; omit to use default snow-connector profile
 * @param {string} [options.initialUrl] - URL to open after launch (optional)
 * @returns {Promise<import('puppeteer').Browser>} The launched browser instance
 */
async function launch(options = {}) {
  const profileDir = options.userDataDir || getFirefoxProfileDir();
  configureFirefoxPasswordSaving(profileDir);

  const launchOptions = {
    headless: false,
    timeout: 60000,
    browser: 'firefox',
    userDataDir: profileDir,
    extraPrefsFirefox: {
      'signon.rememberSignons': true,
      'signon.autofillForms': true,
      'signon.autofillForms.http': true,
      'signon.userInputRequiredToCapture.enabled': false,
      'signon.privateBrowsingCapture.enabled': true,
      'signon.storeWhenAutocompleteOff': true,
    },
    args: [],
    dumpio: false,
    defaultViewport: null,
  };

  if (options.executablePath) {
    launchOptions.executablePath = options.executablePath;
  }

  const doLaunch = async (opts) => {
    const browser = await puppeteer.launch(opts);
    if (options.initialUrl) {
      try {
        const pages = await browser.pages();
        const page = pages[0] || await browser.newPage();
        await page.goto(options.initialUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch (error) {
        // Browser is running; navigation is best-effort
      }
    }
    return browser;
  };

  try {
    return await doLaunch(launchOptions);
  } catch (error) {
    if (error.message.includes('Code: 0') || error.message.includes('Failed to launch')) {
      delete launchOptions.browser;
      launchOptions.product = 'firefox';
      try {
        return await doLaunch(launchOptions);
      } catch (fallbackError) {
        throw new Error(formatFirefoxError(fallbackError));
      }
    }
    throw new Error(formatFirefoxError(error));
  }
}

module.exports = {
  launch,
  getFirefoxProfileDir,
  configureFirefoxPasswordSaving,
};
