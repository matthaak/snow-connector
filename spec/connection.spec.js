// connection.spec.js
const { Connection } = require('../connection');
const {
  getModelProvider,
  setBrowserProvider,
  setHealthCheckerFactory,
} = require('../providers.js');

describe('Connection', () => {
  let model;
  let connection;
  let browser;
  let healthChecker;
  const id = 0;
  const url = 'https://testdummy.service-now.com';
  const urlDomain = 'testdummy.service-now.com';
  const validationInterval = 1; // 1ms for fast tests

  beforeEach(() => {
    model = getModelProvider().getModel();
    model.reset();

    browser = {
      // Mock browser that can set cookies on the model (global browser_cookies key)
      setCookies: (cookiesObj) => {
        model.set('browser_cookies', cookiesObj);
      },
      setCookieForDomain: (domain, cookieValue) => {
        const currentCookies = model.get('browser_cookies') || {};
        const newCookies = { ...currentCookies, [domain]: cookieValue };
        model.set('browser_cookies', newCookies);
      },
      removeCookieForDomain: (domain) => {
        const currentCookies = model.get('browser_cookies') || {};
        const newCookies = { ...currentCookies };
        delete newCookies[domain];
        model.set('browser_cookies', newCookies);
      },
      setCookie: (cookieValue) => {
        browser.setCookieForDomain(urlDomain, cookieValue);
      },
      setGcks: (gCksObj) => {
        model.set('browser_g_cks', gCksObj);
      },
      setGckForDomain: (domain, gCkValue) => {
        const current = model.get('browser_g_cks') || {};
        const next = { ...current, [domain]: gCkValue };
        model.set('browser_g_cks', next);
      }
    };
    healthChecker = {
      doCheck: jasmine.createSpy('doCheck').and.returnValue(true)
    };

    // Override browser and health checker factory so Connection gets mock browser and mock health checker
    setBrowserProvider({ getBrowser: () => browser });
    setHealthCheckerFactory({ create: () => healthChecker });

    // Connection reads url and validationInterval from model
    model.set(`${id}_url`, url);
    model.set(`${id}_validationInterval`, validationInterval);

    // Initialize with empty cookies object
    browser.setCookies({});
  });

  afterEach(() => {
    if (connection) {
      connection.disconnect();
      connection = null;
    }
    try {
      jasmine.clock().uninstall();
    } catch (e) {
      // Clock not installed, ignore
    }
  });

  describe('Initialization', () => {
    it('should set connection status to "off" on init', () => {
      connection = new Connection({ id });

      expect(model.get('0_conn_status')).toBe('off');
    });

    it('should listen for browser cookie changes', (done) => {
      connection = new Connection({ id });

      // Set initial cookie with session store (from null to having it - should turn on)
      browser.setCookie('glide_session_store=abc123');
      
      // Wait a bit for the change handler
      setTimeout(() => {
        expect(model.get('0_conn_status')).toBe('on'); // Should turn on (null -> has glide_session_store)
        expect(model.get('0_conn_glide_session_store')).toBe('abc123');
        done();
      }, 10);
    });
  });

  describe('Method A: Turning on via browser cookie change', () => {
    it('should turn on when browser cookie changes with new glide_session_store', (done) => {
      connection = new Connection({ id });

      // Set initial cookie (will turn on from null -> has value)
      browser.setCookie('glide_session_store=abc123');
      
      setTimeout(() => {
        // Disconnect first to test the change scenario
        connection.disconnect();
        expect(model.get('0_conn_status')).toBe('off');
        
        // Set a different session store value
        browser.setCookie('glide_session_store=xyz789');
        
        setTimeout(() => {
          expect(model.get('0_conn_status')).toBe('on');
          expect(model.get('0_conn_glide_session_store')).toBe('xyz789');
          done();
        }, 10);
      }, 10);
    });

    it('should not turn on if glide_session_store value has not changed', (done) => {
      connection = new Connection({ id });

      // Set initial cookie (will turn on from null -> has value)
      browser.setCookie('glide_session_store=abc123');
      
      setTimeout(() => {
        expect(model.get('0_conn_status')).toBe('on');
        expect(model.get('0_conn_glide_session_store')).toBe('abc123');
        
        // Disconnect to test same value scenario
        connection.disconnect();
        expect(model.get('0_conn_status')).toBe('off');
        
        // Set the same session store value again (should not turn on - same value)
        browser.setCookie('glide_session_store=abc123');
        
        setTimeout(() => {
          expect(model.get('0_conn_status')).toBe('off');
          expect(model.get('0_conn_glide_session_store')).toBe('abc123');
          done();
        }, 10);
      }, 10);
    });

    it('should not turn on if cookie does not contain glide_session_store', (done) => {
      connection = new Connection({ id });

      browser.setCookie('some_other_cookie=value');
      
      setTimeout(() => {
        expect(model.get('0_conn_status')).toBe('off');
        done();
      }, 10);
    });

    it('should turn on when cookie changes from null to having glide_session_store', (done) => {
      connection = new Connection({ id });

      // Initially no cookie (null/undefined)
      expect(model.get('0_browser_cookie')).toBeUndefined();
      
      // Set cookie with glide_session_store
      browser.setCookie('glide_session_store=abc123');
      
      setTimeout(() => {
        expect(model.get('0_conn_status')).toBe('on');
        expect(model.get('0_conn_glide_session_store')).toBe('abc123');
        done();
      }, 10);
    });

    it('should turn on when cookie changes from lacking glide_session_store to having it', (done) => {
      connection = new Connection({ id });

      // Set cookie without glide_session_store
      browser.setCookie('some_other_cookie=value');
      
      setTimeout(() => {
        expect(model.get('0_conn_status')).toBe('off');
        
        // Change to cookie with glide_session_store
        browser.setCookie('glide_session_store=abc123; some_other_cookie=value');
        
        setTimeout(() => {
          expect(model.get('0_conn_status')).toBe('on');
          expect(model.get('0_conn_glide_session_store')).toBe('abc123');
          done();
        }, 10);
      }, 10);
    });

    it('should not turn on when cookie changes from having glide_session_store to lacking it (if already off)', (done) => {
      connection = new Connection({ id });

      // Set cookie with glide_session_store (turns on)
      browser.setCookie('glide_session_store=abc123');
      
      setTimeout(() => {
        expect(model.get('0_conn_status')).toBe('on');
        
        // Manually disconnect first
        connection.disconnect();
        expect(model.get('0_conn_status')).toBe('off');
        
        // Change to cookie without glide_session_store (should stay off)
        browser.setCookie('some_other_cookie=value');
        
        setTimeout(() => {
          // Should remain off (not turn on)
          expect(model.get('0_conn_status')).toBe('off');
          done();
        }, 10);
      }, 10);
    });

    it('should not turn on when cookie is set for different domain', (done) => {
      connection = new Connection({ id });

      // Set cookie for a different ServiceNow instance domain
      browser.setCookieForDomain('different-instance.service-now.com', 'glide_session_store=abc123');
      
      setTimeout(() => {
        // Should not turn on because cookie is for different domain
        expect(model.get('0_conn_status')).toBe('off');
        done();
      }, 10);
    });

    it('should turn on when cookie is set for matching domain', (done) => {
      connection = new Connection({ id });

      // Set cookie for the connection's domain
      browser.setCookie('glide_session_store=abc123');
      
      setTimeout(() => {
        // Should turn on because cookie is for matching domain
        expect(model.get('0_conn_status')).toBe('on');
        done();
      }, 10);
    });

    it('should disconnect when cookie for matching domain is removed', (done) => {
      connection = new Connection({ id });

      // Set cookie for matching domain (turns on)
      browser.setCookie('glide_session_store=abc123');
      
      setTimeout(() => {
        expect(model.get('0_conn_status')).toBe('on');
        
        // Remove cookie for this domain
        browser.removeCookieForDomain(urlDomain);
        
        setTimeout(() => {
          // Should disconnect when cookie for this domain is removed
          expect(model.get('0_conn_status')).toBe('off');
          done();
        }, 10);
      }, 10);
    });

    it('should ignore cookie changes for other domains', (done) => {
      connection = new Connection({ id });

      // Set cookie for a different domain - should not turn on
      browser.setCookieForDomain('other-instance.service-now.com', 'glide_session_store=xyz789');
      
      setTimeout(() => {
        expect(model.get('0_conn_status')).toBe('off');
        
        // Change cookie for other domain - should not affect connection
        browser.setCookieForDomain('other-instance.service-now.com', 'glide_session_store=abc123');
        
        setTimeout(() => {
          // Should still be off - other domain changes don't affect this connection
          expect(model.get('0_conn_status')).toBe('off');
          done();
        }, 10);
      }, 10);
    });
  });

  describe('Method R: Disconnecting via cookie loss', () => {
    it('should disconnect when cookie changes from having glide_session_store to lacking it', (done) => {
      connection = new Connection({ id });

      // Set cookie with glide_session_store (turns on)
      browser.setCookie('glide_session_store=abc123');
      
      setTimeout(() => {
        expect(model.get('0_conn_status')).toBe('on');
        
        // Change to cookie without glide_session_store (should disconnect)
        browser.setCookie('some_other_cookie=value');
        
        setTimeout(() => {
          // Should turn off when session store is lost
          expect(model.get('0_conn_status')).toBe('off');
          done();
        }, 10);
      }, 10);
    });

    it('should disconnect when cookie for domain is removed from cookies object', (done) => {
      connection = new Connection({ id });

      // Set cookie with glide_session_store (turns on)
      browser.setCookie('glide_session_store=abc123');
      
      setTimeout(() => {
        expect(model.get('0_conn_status')).toBe('on');
        
        // Remove cookie for this domain
        browser.removeCookieForDomain(urlDomain);
        
        setTimeout(() => {
          // Should turn off when cookie for this domain is removed
          expect(model.get('0_conn_status')).toBe('off');
          done();
        }, 10);
      }, 10);
    });
  });

  describe('Method B: Turning on via connect() method', () => {
    it('should turn on and return true if health check passes', async () => {
      connection = new Connection({ id });

      browser.setCookie('glide_session_store=abc123');
      
      // Wait for cookie change handler to potentially turn it on, then disconnect
      await new Promise((r) => setTimeout(r, 10));
      connection.disconnect();
      expect(model.get('0_conn_status')).toBe('off');

      healthChecker.doCheck.and.returnValue(true);
      healthChecker.doCheck.calls.reset(); // Reset call count

      const result = await connection.connect();

      expect(result).toBe(true);
      expect(model.get('0_conn_status')).toBe('on');
      expect(model.get('0_conn_glide_session_store')).toBe('abc123');
      expect(healthChecker.doCheck).toHaveBeenCalledWith();
    });

    it('should not turn on if health check fails', async () => {
      connection = new Connection({ id });

      browser.setCookie('glide_session_store=abc123');
      
      // Wait for cookie change handler to potentially turn it on, then disconnect
      await new Promise((r) => setTimeout(r, 10));
      connection.disconnect();
      expect(model.get('0_conn_status')).toBe('off');
      
      healthChecker.doCheck.and.returnValue(false); // Make health check fail
      healthChecker.doCheck.calls.reset(); // Reset call count

      const result = await connection.connect();

      expect(result).toBe(false);
      expect(model.get('0_conn_status')).toBe('off');
      expect(healthChecker.doCheck).toHaveBeenCalledWith();
    });


    it('should not turn on if health check fails (condition ii fails)', async () => {
      connection = new Connection({ id });

      browser.setCookie('glide_session_store=abc123');
      
      // Wait for cookie change handler to potentially turn it on, then disconnect
      await new Promise((r) => setTimeout(r, 10));
      connection.disconnect();
      expect(model.get('0_conn_status')).toBe('off');
      
      healthChecker.doCheck.and.returnValue(false);
      healthChecker.doCheck.calls.reset(); // Reset call count

      const result = await connection.connect();

      expect(result).toBe(false);
      expect(model.get('0_conn_status')).toBe('off');
      expect(healthChecker.doCheck).toHaveBeenCalledWith();
    });

    it('should return false if cookie does not contain glide_session_store', async () => {
      connection = new Connection({ id });

      browser.setCookie('some_other_cookie=value');

      const result = await connection.connect();

      expect(result).toBe(false);
      expect(model.get('0_conn_status')).toBe('off');
      expect(healthChecker.doCheck).not.toHaveBeenCalledWith();
    });

    it('should return false if cookie is not set', async () => {
      connection = new Connection({ id });

      const result = await connection.connect();

      expect(result).toBe(false);
      expect(model.get('0_conn_status')).toBe('off');
    });
  });

  describe('Method P: Disconnecting via validation loop', () => {
    beforeEach(() => {
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date(1000000)); // Set a fixed base time
    });

    afterEach(() => {
      jasmine.clock().uninstall();
    });

    it('should disconnect when health check fails during validation loop', async () => {
      connection = new Connection({ id });

      // Turn connection on
      const now = Date.now();
      model.set('0_last_activity', now);
      browser.setCookie('glide_session_store=abc123');
      await connection.connect();

      expect(model.get('0_conn_status')).toBe('on');

      // Reset spy to track new calls
      healthChecker.doCheck.calls.reset();

      // Set last activity to be older than validationInterval
      model.set('0_last_activity', now - validationInterval - 1);
      
      // Make health check fail
      healthChecker.doCheck.and.returnValue(false);

      // Advance time to trigger validation loop
      jasmine.clock().tick(validationInterval + 1);

      // Allow promise from doCheck to settle
      await new Promise((r) => setImmediate(r));

      expect(model.get('0_conn_status')).toBe('off');
      expect(healthChecker.doCheck).toHaveBeenCalledWith();
    });

    it('should not disconnect when health check passes during validation loop', async () => {
      connection = new Connection({ id });

      // Turn connection on
      const now = Date.now();
      model.set('0_last_activity', now);
      browser.setCookie('glide_session_store=abc123');
      await connection.connect();

      expect(model.get('0_conn_status')).toBe('on');

      // Reset spy
      healthChecker.doCheck.calls.reset();

      // Set last activity to be older than validationInterval
      model.set('0_last_activity', now - validationInterval - 1);
      
      // Make health check pass
      healthChecker.doCheck.and.returnValue(true);

      // Advance time to trigger validation loop
      jasmine.clock().tick(validationInterval + 1);

      // Allow promise from doCheck to settle
      await new Promise((r) => setImmediate(r));

      expect(model.get('0_conn_status')).toBe('on');
      expect(healthChecker.doCheck).toHaveBeenCalledWith();
    });

    it('should not check health if last activity is recent', async () => {
      connection = new Connection({ id });

      // Turn connection on
      const now = Date.now();
      model.set('0_last_activity', now);
      browser.setCookie('glide_session_store=abc123');
      await connection.connect();

      expect(model.get('0_conn_status')).toBe('on');

      // Reset spy
      healthChecker.doCheck.calls.reset();

      // Update last activity to current time (keep it recent)
      model.set('0_last_activity', Date.now());
      
      // Advance time by less than validationInterval
      jasmine.clock().tick(validationInterval - 1);

      // Health check should not be called because last activity is recent
      expect(healthChecker.doCheck).not.toHaveBeenCalledWith();
      expect(model.get('0_conn_status')).toBe('on');
    });

    it('should stop validation loop when connection goes off', async () => {
      connection = new Connection({ id });

      // Turn connection on
      const now = Date.now();
      model.set('0_last_activity', now);
      browser.setCookie('glide_session_store=abc123');
      await connection.connect();

      expect(model.get('0_conn_status')).toBe('on');

      // Reset spy
      healthChecker.doCheck.calls.reset();

      // Disconnect manually
      connection.disconnect();
      expect(model.get('0_conn_status')).toBe('off');

      // Advance time - validation loop should not run
      const callCountBefore = healthChecker.doCheck.calls.count();
      jasmine.clock().tick(validationInterval + 1);

      expect(healthChecker.doCheck.calls.count()).toBe(callCountBefore);
    });
  });

  describe('Method Q: Disconnecting via disconnect() method', () => {
    it('should set status to "off" when disconnect() is called', (done) => {
      connection = new Connection({ id });

      // Turn connection on first - set initial cookie (null -> has value turns on)
      browser.setCookie('glide_session_store=abc123');
      
      setTimeout(() => {
        expect(model.get('0_conn_status')).toBe('on');

        connection.disconnect();

        expect(model.get('0_conn_status')).toBe('off');
        done();
      }, 10);
    });

    it('should stop validation loop when disconnect() is called', async () => {
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date(1000000));
      connection = new Connection({ id });

      // Turn connection on
      const now = Date.now();
      model.set('0_last_activity', now);
      browser.setCookie('glide_session_store=abc123');
      await connection.connect();

      expect(model.get('0_conn_status')).toBe('on');

      // Reset spy
      healthChecker.doCheck.calls.reset();

      // Disconnect
      connection.disconnect();

      // Advance time - validation loop should not run
      const callCountBefore = healthChecker.doCheck.calls.count();
      jasmine.clock().tick(validationInterval + 1);

      expect(healthChecker.doCheck.calls.count()).toBe(callCountBefore);
      jasmine.clock().uninstall();
    });
  });

  describe('Integration: Multiple state transitions', () => {
    it('should handle turning on via method A, then off via method P', async () => {
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date(1000000));
      connection = new Connection({ id });

      // Turn on via method A - set initial cookie (null -> has value turns on)
      browser.setCookie('glide_session_store=abc123');
      
      // Advance time to process first cookie
      jasmine.clock().tick(10);
      
      expect(model.get('0_conn_status')).toBe('on');

      // Reset spy
      healthChecker.doCheck.calls.reset();

      // Set up for method P disconnect
      const now = Date.now();
      model.set('0_last_activity', now - validationInterval - 1);
      healthChecker.doCheck.and.returnValue(false);

      // Advance time to trigger validation loop
      jasmine.clock().tick(validationInterval + 1);

      // Allow promise from doCheck to settle
      await new Promise((r) => setImmediate(r));

      expect(model.get('0_conn_status')).toBe('off');
      jasmine.clock().uninstall();
    });

    it('should handle turning on via method B, then off via method Q', async () => {
      connection = new Connection({ id });

      // Turn on via method B (requires health check to pass)
      browser.setCookie('glide_session_store=abc123');
      healthChecker.doCheck.and.returnValue(true);
      const result = await connection.connect();

      expect(result).toBe(true);
      expect(model.get('0_conn_status')).toBe('on');

      // Turn off via method Q
      connection.disconnect();

      expect(model.get('0_conn_status')).toBe('off');
    });

    it('should handle turning on via method A, then off via method R', (done) => {
      connection = new Connection({ id });

      // Turn on via method A - set initial cookie (null -> has value turns on)
      browser.setCookie('glide_session_store=abc123');
      
      setTimeout(() => {
        expect(model.get('0_conn_status')).toBe('on');

        // Turn off via method R - change cookie to lack glide_session_store
        browser.setCookie('some_other_cookie=value');
        
        setTimeout(() => {
          expect(model.get('0_conn_status')).toBe('off');
          done();
        }, 10);
      }, 10);
    });
  });
});
