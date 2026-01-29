// connection.spec.js
const { Connection } = require('../connection');
const { ObservableModel } = require('model-manager/observable-model');

describe('Connection', () => {
  let model;
  let browser;
  let healthChecker;
  const id = 0;
  const url = 'https://testdummy.service-now.com';
  const urlDomain = 'testdummy.service-now.com';
  const validationInterval = 1; // 1ms for fast tests

  beforeEach(() => {
    model = new ObservableModel();
    browser = {
      // Mock browser that can set cookies on the model
      // cookiesObj should be { "domain.com": "cookie string", ... }
      setCookies: (cookiesObj) => {
        model.set(`${id}_browser_cookies`, cookiesObj);
      },
      // Helper to set cookie for a specific domain
      setCookieForDomain: (domain, cookieValue) => {
        const currentCookies = model.get(`${id}_browser_cookies`) || {};
        const newCookies = { ...currentCookies, [domain]: cookieValue };
        model.set(`${id}_browser_cookies`, newCookies);
      },
      // Helper to remove cookie for a specific domain
      removeCookieForDomain: (domain) => {
        const currentCookies = model.get(`${id}_browser_cookies`) || {};
        const newCookies = { ...currentCookies };
        delete newCookies[domain];
        model.set(`${id}_browser_cookies`, newCookies);
      },
      // Convenience method to set cookie for the test URL domain
      setCookie: (cookieValue) => {
        browser.setCookieForDomain(urlDomain, cookieValue);
      }
    };
    healthChecker = {
      doCheck: jasmine.createSpy('doCheck').and.returnValue(true)
    };
    
    // Initialize with empty cookies object
    browser.setCookies({});
  });

  afterEach(() => {
    // Clean up any timers if clock is installed
    try {
      jasmine.clock().uninstall();
    } catch (e) {
      // Clock not installed, ignore
    }
  });

  describe('Initialization', () => {
    it('should set connection status to "off" on init', () => {
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

      expect(model.get('0_conn_status')).toBe('off');
    });

    it('should listen for browser cookie changes', (done) => {
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

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
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

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
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

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
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

      browser.setCookie('some_other_cookie=value');
      
      setTimeout(() => {
        expect(model.get('0_conn_status')).toBe('off');
        done();
      }, 10);
    });

    it('should turn on when cookie changes from null to having glide_session_store', (done) => {
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

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
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

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
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

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
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

      // Set cookie for a different ServiceNow instance domain
      browser.setCookieForDomain('different-instance.service-now.com', 'glide_session_store=abc123');
      
      setTimeout(() => {
        // Should not turn on because cookie is for different domain
        expect(model.get('0_conn_status')).toBe('off');
        done();
      }, 10);
    });

    it('should turn on when cookie is set for matching domain', (done) => {
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

      // Set cookie for the connection's domain
      browser.setCookie('glide_session_store=abc123');
      
      setTimeout(() => {
        // Should turn on because cookie is for matching domain
        expect(model.get('0_conn_status')).toBe('on');
        done();
      }, 10);
    });

    it('should disconnect when cookie for matching domain is removed', (done) => {
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

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
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

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
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

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
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

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
    it('should turn on and return true if health check passes', (done) => {
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

      browser.setCookie('glide_session_store=abc123');
      
      // Wait for cookie change handler to potentially turn it on, then disconnect
      setTimeout(() => {
        connection.disconnect();
        expect(model.get('0_conn_status')).toBe('off');

        healthChecker.doCheck.and.returnValue(true);
        healthChecker.doCheck.calls.reset(); // Reset call count

        const result = connection.connect();

        expect(result).toBe(true);
        expect(model.get('0_conn_status')).toBe('on');
        expect(model.get('0_conn_glide_session_store')).toBe('abc123');
        expect(healthChecker.doCheck).toHaveBeenCalled();
        done();
      }, 10);
    });

    it('should not turn on if health check fails', (done) => {
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

      browser.setCookie('glide_session_store=abc123');
      
      // Wait for cookie change handler to potentially turn it on, then disconnect
      setTimeout(() => {
        connection.disconnect();
        expect(model.get('0_conn_status')).toBe('off');
        
        healthChecker.doCheck.and.returnValue(false); // Make health check fail
        healthChecker.doCheck.calls.reset(); // Reset call count

        const result = connection.connect();

        expect(result).toBe(false);
        expect(model.get('0_conn_status')).toBe('off');
        expect(healthChecker.doCheck).toHaveBeenCalled();
        done();
      }, 10);
    });


    it('should not turn on if health check fails (condition ii fails)', (done) => {
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

      browser.setCookie('glide_session_store=abc123');
      
      // Wait for cookie change handler to potentially turn it on, then disconnect
      setTimeout(() => {
        connection.disconnect();
        expect(model.get('0_conn_status')).toBe('off');
        
        healthChecker.doCheck.and.returnValue(false);
        healthChecker.doCheck.calls.reset(); // Reset call count

        const result = connection.connect();

        expect(result).toBe(false);
        expect(model.get('0_conn_status')).toBe('off');
        expect(healthChecker.doCheck).toHaveBeenCalled();
        done();
      }, 10);
    });

    it('should return false if cookie does not contain glide_session_store', () => {
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

      browser.setCookie('some_other_cookie=value');

      const result = connection.connect();

      expect(result).toBe(false);
      expect(model.get('0_conn_status')).toBe('off');
      expect(healthChecker.doCheck).not.toHaveBeenCalled();
    });

    it('should return false if cookie is not set', () => {
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

      const result = connection.connect();

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

    it('should disconnect when health check fails during validation loop', () => {
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

      // Turn connection on
      const now = Date.now();
      model.set('0_last_activity', now);
      browser.setCookie('glide_session_store=abc123');
      connection.connect();

      expect(model.get('0_conn_status')).toBe('on');

      // Reset spy to track new calls
      healthChecker.doCheck.calls.reset();

      // Set last activity to be older than validationInterval
      model.set('0_last_activity', now - validationInterval - 1);
      
      // Make health check fail
      healthChecker.doCheck.and.returnValue(false);

      // Advance time to trigger validation loop
      jasmine.clock().tick(validationInterval + 1);

      expect(model.get('0_conn_status')).toBe('off');
      expect(healthChecker.doCheck).toHaveBeenCalled();
    });

    it('should not disconnect when health check passes during validation loop', () => {
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

      // Turn connection on
      const now = Date.now();
      model.set('0_last_activity', now);
      browser.setCookie('glide_session_store=abc123');
      connection.connect();

      expect(model.get('0_conn_status')).toBe('on');

      // Reset spy
      healthChecker.doCheck.calls.reset();

      // Set last activity to be older than validationInterval
      model.set('0_last_activity', now - validationInterval - 1);
      
      // Make health check pass
      healthChecker.doCheck.and.returnValue(true);

      // Advance time to trigger validation loop
      jasmine.clock().tick(validationInterval + 1);

      expect(model.get('0_conn_status')).toBe('on');
      expect(healthChecker.doCheck).toHaveBeenCalled();
    });

    it('should not check health if last activity is recent', () => {
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

      // Turn connection on
      const now = Date.now();
      model.set('0_last_activity', now);
      browser.setCookie('glide_session_store=abc123');
      connection.connect();

      expect(model.get('0_conn_status')).toBe('on');

      // Reset spy
      healthChecker.doCheck.calls.reset();

      // Update last activity to current time (keep it recent)
      model.set('0_last_activity', Date.now());
      
      // Advance time by less than validationInterval
      jasmine.clock().tick(validationInterval - 1);

      // Health check should not be called because last activity is recent
      expect(healthChecker.doCheck).not.toHaveBeenCalled();
      expect(model.get('0_conn_status')).toBe('on');
    });

    it('should stop validation loop when connection goes off', () => {
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

      // Turn connection on
      const now = Date.now();
      model.set('0_last_activity', now);
      browser.setCookie('glide_session_store=abc123');
      connection.connect();

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
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

      // Turn connection on first - set initial cookie (null -> has value turns on)
      browser.setCookie('glide_session_store=abc123');
      
      setTimeout(() => {
        expect(model.get('0_conn_status')).toBe('on');

        connection.disconnect();

        expect(model.get('0_conn_status')).toBe('off');
        done();
      }, 10);
    });

    it('should stop validation loop when disconnect() is called', () => {
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date(1000000));
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

      // Turn connection on
      const now = Date.now();
      model.set('0_last_activity', now);
      browser.setCookie('glide_session_store=abc123');
      connection.connect();

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
    it('should handle turning on via method A, then off via method P', () => {
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date(1000000));
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

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

      // Advance time to trigger validation
      jasmine.clock().tick(validationInterval + 1);

      expect(model.get('0_conn_status')).toBe('off');
      jasmine.clock().uninstall();
    });

    it('should handle turning on via method B, then off via method Q', () => {
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

      // Turn on via method B (requires health check to pass)
      browser.setCookie('glide_session_store=abc123');
      healthChecker.doCheck.and.returnValue(true);
      const result = connection.connect();

      expect(result).toBe(true);
      expect(model.get('0_conn_status')).toBe('on');

      // Turn off via method Q
      connection.disconnect();

      expect(model.get('0_conn_status')).toBe('off');
    });

    it('should handle turning on via method A, then off via method R', (done) => {
      const connection = new Connection({
        model,
        id,
        url,
        browser,
        healthChecker,
        validationInterval
      });

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
