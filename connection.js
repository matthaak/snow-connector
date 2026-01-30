// connection.js
/**
 * Connection class manages connection state to a ServiceNow instance.
 * 
 * Connection obtains model and browser from providers, and health checker from a factory.
 * 
 * Connection Methods (turning "on"):
 * - Method A: Automatically turns on when browser cookies for the connection's domain
 *   change from not having glide_session_store to having it, or when the glide_session_store
 *   value changes. Monitors ${id}_browser_cookies object (domain -> cookie string mapping).
 *   Handled by handleModelChange().
 * - Method B: Manually turns on via connect() method. Requires health check to pass.
 * 
 * Disconnection Methods (turning "off"):
 * - Method P: Automatically disconnects via validation loop when health check fails
 *   after detecting stale activity (last activity >= validationInterval ms ago).
 *   Handled by startValidationLoop().
 * - Method Q: Manually disconnects via disconnect() method.
 * - Method R: Automatically disconnects when browser cookies for the connection's domain
 *   change from having glide_session_store to not having it (or being deleted).
 *   Monitors ${id}_browser_cookies object. Handled by handleModelChange().
 */

const {
  getModelProvider,
  getBrowserProvider,
  getHealthCheckerFactory,
} = require('./providers.js');

class Connection {
  constructor({ id }) {
    this.id = id;
    this.model = getModelProvider().getModel();
    this.browser = getBrowserProvider().getBrowser();
    this.healthChecker = getHealthCheckerFactory().create(id);

    // Initialize connection status
    const statusKey = `${id}_conn_status`;
    this.model.set(statusKey, 'off');

    // Store key names for convenience (url and validationInterval read from model)
    this.statusKey = statusKey;
    this.urlKey = `${id}_url`;
    this.validationIntervalKey = `${id}_validationInterval`;
    this.cookiesKey = `${id}_browser_cookies`; // Object: domain -> cookie string
    this.sessionStoreKey = `${id}_conn_glide_session_store`;
    this.lastActivityKey = `${id}_last_activity`;

    // Track validation interval timer
    this.validationTimer = null;

    // Listen for browser cookies changes
    this.model.on('change', this.handleModelChange.bind(this));
  }

  getUrlFqdn() {
    const url = this.model.get(this.urlKey);
    return this.extractFqdn(url);
  }

  /**
   * Extracts FQDN from a URL (e.g., "https://dev224422.service-now.com" -> "dev224422.service-now.com")
   * @param {string} url - The URL to extract FQDN from
   * @returns {string|null} The FQDN or null if invalid
   */
  extractFqdn(url) {
    if (!url || typeof url !== 'string') {
      return null;
    }
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch (e) {
      // If URL parsing fails, try to extract manually
      const match = url.match(/https?:\/\/([^\/]+)/);
      return match ? match[1] : null;
    }
  }

  handleModelChange(event) {
    // Only process changes to the browser cookies key
    if (event.key !== this.cookiesKey) {
      return;
    }

    const isCurrentlyOn = this.model.get(this.statusKey) === 'on';

    // Get the cookies object (domain -> cookie string mapping)
    const newCookiesObj = event.newValue || {};
    const oldCookiesObj = event.oldValue || {};

    // Get cookies for this connection's domain
    const urlFqdn = this.getUrlFqdn();
    const newCookieValue = (typeof newCookiesObj === 'object' && newCookiesObj !== null) 
      ? newCookiesObj[urlFqdn] 
      : null;
    const oldCookieValue = (typeof oldCookiesObj === 'object' && oldCookiesObj !== null) 
      ? oldCookiesObj[urlFqdn] 
      : null;

    // Extract glide_session_store from new cookie (for this domain)
    let newSessionStore = null;
    if (newCookieValue && typeof newCookieValue === 'string') {
      const sessionStoreMatch = newCookieValue.match(/glide_session_store=([^;]+)/);
      if (sessionStoreMatch) {
        newSessionStore = sessionStoreMatch[1];
      }
    }

    // Extract glide_session_store from old cookie (for this domain)
    let oldSessionStore = null;
    if (oldCookieValue && typeof oldCookieValue === 'string') {
      const sessionStoreMatch = oldCookieValue.match(/glide_session_store=([^;]+)/);
      if (sessionStoreMatch) {
        oldSessionStore = sessionStoreMatch[1];
      }
    }

    // Method R: Handle disconnection when cookie for this domain goes from having glide_session_store to not having it
    if (isCurrentlyOn && oldSessionStore !== null && newSessionStore === null) {
      this.model.set(this.statusKey, 'off');
      this.stopValidationLoop();
      return;
    }

    // Don't process turn-on logic if already on
    if (isCurrentlyOn) {
      return;
    }

    // If new cookie has glide_session_store, store it
    if (newSessionStore) {
      this.model.set(this.sessionStoreKey, newSessionStore);
    }

    // Method A: Turn on if (for this domain):
    // 1. Old cookie had no glide_session_store (or was null) and new cookie has it, OR
    // 2. Old cookie had a different glide_session_store value than new cookie
    if (newSessionStore && (oldSessionStore === null || oldSessionStore !== newSessionStore)) {
      this.model.set(this.statusKey, 'on');
      this.model.set(this.lastActivityKey, Date.now()); // stamp so validation loop can run; health checker will refresh on success
      this.startValidationLoop();
    }
  }

  /**
   * Method B: Manually connect the connection.
   * Requires health check to pass.
   * Uses cookies for this connection's domain from browser_cookies object.
   * @returns {Promise<boolean>} Resolves with true if connection was turned on, false otherwise
   */
  async connect() {
    const cookiesObj = this.model.get(this.cookiesKey);
    if (!cookiesObj || typeof cookiesObj !== 'object' || cookiesObj === null) {
      return false;
    }

    // Get cookie for this connection's domain
    const urlFqdn = this.getUrlFqdn();
    const cookie = cookiesObj[urlFqdn];
    if (!cookie || typeof cookie !== 'string') {
      return false;
    }

    // Check if cookie contains glide_session_store
    const sessionStoreMatch = cookie.match(/glide_session_store=([^;]+)/);
    if (!sessionStoreMatch) {
      return false;
    }

    const sessionStore = sessionStoreMatch[1];

    // Method B: Always perform health check (supports sync or async doCheck)
    if (this.healthChecker && typeof this.healthChecker.doCheck === 'function') {
      const ok = await Promise.resolve(this.healthChecker.doCheck());
      if (ok) {
        this.model.set(this.sessionStoreKey, sessionStore);
        this.model.set(this.statusKey, 'on');
        this.startValidationLoop();
        return true;
      }
    }

    return false;
  }

  /**
   * Method Q: Manually disconnect the connection.
   */
  disconnect() {
    this.model.set(this.statusKey, 'off');
    this.stopValidationLoop();
  }

  /**
   * Starts the validation loop that implements Method P.
   * Checks every validationInterval ms if activity is stale and performs health check.
   * Disconnects if health check fails.
   */
  startValidationLoop() {
    // Stop any existing loop
    this.stopValidationLoop();

    // Only start if connection is on
    if (this.model.get(this.statusKey) !== 'on') {
      return;
    }

    const validationInterval = this.model.get(this.validationIntervalKey) || 0;
    if (!validationInterval) {
      return;
    }

    this.validationTimer = setInterval(() => {
      // Check if connection is still on
      if (this.model.get(this.statusKey) !== 'on') {
        this.stopValidationLoop();
        return;
      }

      const lastActivity = this.model.get(this.lastActivityKey);
      if (!lastActivity) {
        return;
      }

      const now = Date.now();
      const timeSinceActivity = now - lastActivity;
      const interval = this.model.get(this.validationIntervalKey) || 0;

      // Method P: If last activity is at or before validationInterval ms ago, check health
      if (timeSinceActivity >= interval) {
        if (this.healthChecker && typeof this.healthChecker.doCheck === 'function') {
          Promise.resolve(this.healthChecker.doCheck()).then((ok) => {
            if (!ok) {
              this.model.set(this.statusKey, 'off');
              this.stopValidationLoop();
            }
          });
        }
      }
    }, validationInterval);
  }

  stopValidationLoop() {
    if (this.validationTimer) {
      clearInterval(this.validationTimer);
      this.validationTimer = null;
    }
  }
}

module.exports = { Connection };
