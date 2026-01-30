/**
 * Wrapper for Puppeteer-launched Chromium or Chrome.
 * Uses a persistent user data directory so password saving and recall work.
 */

const puppeteer = require('puppeteer');
const { join } = require('path');
const { existsSync, mkdirSync, writeFileSync, readFileSync } = require('fs');
const os = require('os');

const PROFILE_DIR_NAME = '.snow_connector_browser_profile';

/**
 * Get the browser profile directory path for Chromium/Chrome.
 * @returns {string} Path to the browser profile directory
 */
function getBrowserProfileDir() {
  const platform = os.platform();
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error('LOCALAPPDATA environment variable not found');
    }
    const profileDir = join(localAppData, 'snow-connector', 'browser-profile');
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
 * Configure Chrome preferences to enable password saving.
 * @param {string} userDataDir - Path to the user data directory
 */
function configurePasswordSaving(userDataDir) {
  const defaultProfileDir = join(userDataDir, 'Default');
  if (!existsSync(defaultProfileDir)) {
    mkdirSync(defaultProfileDir, { recursive: true });
  }

  const preferencesPath = join(defaultProfileDir, 'Preferences');
  let preferences = {};

  if (existsSync(preferencesPath)) {
    try {
      const prefsContent = readFileSync(preferencesPath, 'utf8');
      preferences = JSON.parse(prefsContent);
    } catch (error) {
      // Create new preferences
    }
  }

  preferences.credentials_enable_service = true;
  preferences.credentials_enable_autosignin = true;
  preferences.autofill = preferences.autofill || {};
  preferences.autofill.profile_enabled = true;
  preferences.profile = preferences.profile || {};
  preferences.profile.password_manager_enabled = true;
  if (!preferences.profile.info_cache) {
    preferences.profile.info_cache = {};
  }
  preferences.password_manager = preferences.password_manager || {};
  preferences.password_manager.enabled = true;

  try {
    writeFileSync(preferencesPath, JSON.stringify(preferences), 'utf8');
  } catch (error) {
    // Non-fatal
  }
}

/**
 * Launch Chromium or Chrome.
 * @param {Object} [options] - Launch options
 * @param {string} [options.executablePath] - Path to Chrome/Chromium executable; omit to use Puppeteer's bundled Chromium
 * @param {string} [options.userDataDir] - Override profile directory; omit to use default snow-connector profile
 * @param {string} [options.initialUrl] - URL to open on launch (optional)
 * @returns {Promise<import('puppeteer').Browser>} The launched browser instance
 */
async function launch(options = {}) {
  const userDataDir = options.userDataDir || getBrowserProfileDir();
  configurePasswordSaving(userDataDir);

  const launchOptions = {
    headless: false,
    timeout: 60000,
    userDataDir,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-blink-features=AutomationControlled',
      '--exclude-switches=enable-automation',
      '--disable-infobars',
      '--no-first-run',
      '--no-default-browser-check',
      '--password-store=basic',
    ],
  };

  if (options.executablePath) {
    launchOptions.executablePath = options.executablePath;
  }

  if (options.initialUrl) {
    launchOptions.args.push(options.initialUrl);
  }

  return puppeteer.launch(launchOptions);
}

module.exports = {
  launch,
  getBrowserProfileDir,
  configurePasswordSaving,
};
