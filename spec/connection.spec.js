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
  const url = 'https://testdummy.service-now.com';
  const urlDomain = 'testdummy.service-now.com';
  const validationInterval = 1; // 1ms for fast tests

  beforeEach(() => {
    model = getModelProvider().getModel();
    model.reset();

    const mockWorkerPage = {
      goto: jasmine.createSpy('goto').and.returnValue(Promise.resolve()),
      isClosed: () => false,
      close: jasmine.createSpy('close').and.returnValue(Promise.resolve()),
    };
    browser = {
      isConnected: () => true,
      newPage: jasmine.createSpy('newPage').and.returnValue(Promise.resolve(mockWorkerPage)),
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
      },
    };
    let periodicIntervalId;
    healthChecker = {
      doCheck: jasmine.createSpy('doCheck').and.returnValue(Promise.resolve(true)),
      startPeriodicCheck: jasmine.createSpy('startPeriodicCheck').and.callFake(function () {
        if (periodicIntervalId) {
          clearInterval(periodicIntervalId);
          periodicIntervalId = null;
        }
        periodicIntervalId = setInterval(() => {
          Promise.resolve(healthChecker.doCheck()).then((ok) => {
            if (!ok) {
              model.set(`${healthChecker._connectionId}_conn_status`, 'off');
              if (periodicIntervalId) {
                clearInterval(periodicIntervalId);
                periodicIntervalId = null;
              }
            }
          });
        }, validationInterval);
      }),
      stopPeriodicCheck: jasmine.createSpy('stopPeriodicCheck').and.callFake(function () {
        if (periodicIntervalId) clearInterval(periodicIntervalId);
        periodicIntervalId = null;
        return Promise.resolve();
      }),
    };

    // Override browser and health checker factory so Connection gets mock browser and mock health checker
    setBrowserProvider({ getBrowser: () => browser });
    setHealthCheckerFactory({ create: (cid) => { healthChecker._connectionId = cid; return healthChecker; } });

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
      connection = new Connection({ instanceUrl: url, validationInterval });

      expect(model.get(`${connection.id}_conn_status`)).toBe('off');
    });

    it('should populate model with instanceUrl and validationInterval from constructor', () => {
      connection = new Connection({ instanceUrl: url, validationInterval: 30000 });

      expect(model.get(`${connection.id}_url`)).toBe(url);
      expect(model.get(`${connection.id}_validationInterval`)).toBe(30000);
    });

    it('should default validationInterval to 15000 when not supplied', () => {
      connection = new Connection({ instanceUrl: url });

      expect(model.get(`${connection.id}_url`)).toBe(url);
      expect(model.get(`${connection.id}_validationInterval`)).toBe(15000);
    });

    it('should listen for browser cookie changes', (done) => {
      connection = new Connection({ instanceUrl: url, validationInterval });

      // Set initial cookie with session store (null -> has value); health check runs async then turns on
      browser.setCookie('glide_session_store=abc123');
      setTimeout(() => {
        setImmediate(() => {
          expect(model.get(`${connection.id}_conn_status`)).toBe('on');
          expect(healthChecker.startPeriodicCheck).toHaveBeenCalled();
          done();
        });
      }, 10);
    });
  });

  describe('getWorkerPage and reset', () => {
    it('getWorkerPage returns null when connection is off', async () => {
      connection = new Connection({ instanceUrl: url, validationInterval });
      const page = await connection.getWorkerPage();
      expect(page).toBeNull();
    });

    it('getWorkerPage returns worker page when connection is on', async () => {
      connection = new Connection({ instanceUrl: url, validationInterval });
      browser.setCookie('glide_session_store=abc123');
      await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setImmediate(r)); // let Method A health-check promise resolve
      expect(model.get(`${connection.id}_conn_status`)).toBe('on');
      const page = await connection.getWorkerPage();
      expect(page).toBeTruthy();
      expect(page.goto).toBeDefined();
      expect(browser.newPage).toHaveBeenCalled();
    });

    it('reset navigates worker page to health path', async () => {
      connection = new Connection({ instanceUrl: url, validationInterval });
      browser.setCookie('glide_session_store=abc123');
      await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setImmediate(r)); // let Method A health-check promise resolve
      const page = await connection.getWorkerPage();
      expect(page).toBeTruthy();
      await connection.reset();
      expect(page.goto).toHaveBeenCalled();
    });
  });

  describe('Method A: Turning on via browser cookie change', () => {
    it('turns on when matching-domain cookies change and health check passes', (done) => {
      connection = new Connection({ instanceUrl: url, validationInterval });
      browser.setCookie('some_cookie=value');
      setTimeout(() => {
        setImmediate(() => {
          expect(model.get(`${connection.id}_conn_status`)).toBe('on');
          expect(healthChecker.startPeriodicCheck).toHaveBeenCalled();
          done();
        });
      }, 10);
    });

    it('stays off when health check fails even if cookies change', (done) => {
      connection = new Connection({ instanceUrl: url, validationInterval });
      healthChecker.doCheck.and.returnValue(Promise.resolve(false));
      browser.setCookie('some_cookie=value');
      setTimeout(() => {
        setImmediate(() => {
          expect(model.get(`${connection.id}_conn_status`)).toBe('off');
          done();
        });
      }, 10);
    });

    it('ignores cookie changes for other domains', (done) => {
      connection = new Connection({ instanceUrl: url, validationInterval });
      browser.setCookieForDomain('other-instance.service-now.com', 'some_cookie=value');
      setTimeout(() => {
        expect(model.get(`${connection.id}_conn_status`)).toBe('off');
        done();
      }, 10);
    });
  });

  describe('Method R: Disconnecting via health checks', () => {
    it('does not disconnect solely from cookie loss', (done) => {
      connection = new Connection({ instanceUrl: url, validationInterval });
      browser.setCookie('some_cookie=value');
      setTimeout(() => {
        expect(model.get(`${connection.id}_conn_status`)).toBe('on');
        browser.removeCookieForDomain(urlDomain);
        setTimeout(() => {
          expect(model.get(`${connection.id}_conn_status`)).toBe('on');
          done();
        }, 10);
      }, 10);
    });
  });

  describe('Method B: Turning on via connect() method', () => {
    it('should turn on and return true if health check passes', async () => {
      connection = new Connection({ instanceUrl: url, validationInterval });

      healthChecker.doCheck.and.returnValue(true);
      healthChecker.doCheck.calls.reset(); // Reset call count

      const result = await connection.connect();

      expect(result).toBe(true);
      expect(model.get(`${connection.id}_conn_status`)).toBe('on');
      expect(healthChecker.doCheck).toHaveBeenCalledWith();
    });

    it('should not turn on if health check fails', async () => {
      connection = new Connection({ instanceUrl: url, validationInterval });
      
      healthChecker.doCheck.and.returnValue(false); // Make health check fail
      healthChecker.doCheck.calls.reset(); // Reset call count

      const result = await connection.connect();

      expect(result).toBe(false);
      expect(model.get(`${connection.id}_conn_status`)).toBe('off');
      expect(healthChecker.doCheck).toHaveBeenCalledWith();
    });


    it('should not turn on if health check fails (condition ii fails)', async () => {
      connection = new Connection({ instanceUrl: url, validationInterval });
      
      healthChecker.doCheck.and.returnValue(false);
      healthChecker.doCheck.calls.reset(); // Reset call count

      const result = await connection.connect();

      expect(result).toBe(false);
      expect(model.get(`${connection.id}_conn_status`)).toBe('off');
      expect(healthChecker.doCheck).toHaveBeenCalledWith();
    });

    it('can return true without cookie preconditions when health check passes', async () => {
      connection = new Connection({ instanceUrl: url, validationInterval });
      healthChecker.doCheck.and.returnValue(true);

      const result = await connection.connect();

      expect(result).toBe(true);
      expect(model.get(`${connection.id}_conn_status`)).toBe('on');
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
      connection = new Connection({ instanceUrl: url, validationInterval });

      // Turn connection on
      const now = Date.now();
      model.set(`${connection.id}_last_activity`, now);
      browser.setCookie('glide_session_store=abc123');
      await connection.connect();

      expect(model.get(`${connection.id}_conn_status`)).toBe('on');

      // Reset spy to track new calls
      healthChecker.doCheck.calls.reset();

      // Set last activity to be older than validationInterval
      model.set(`${connection.id}_last_activity`, now - validationInterval - 1);
      
      // Make health check fail
      healthChecker.doCheck.and.returnValue(false);

      // Advance time to trigger validation loop
      jasmine.clock().tick(validationInterval + 1);

      // Allow promise from doCheck to settle
      await new Promise((r) => setImmediate(r));

      expect(model.get(`${connection.id}_conn_status`)).toBe('off');
      expect(healthChecker.doCheck).toHaveBeenCalledWith();
    });

    it('should not disconnect when health check passes during validation loop', async () => {
      connection = new Connection({ instanceUrl: url, validationInterval });

      // Turn connection on
      const now = Date.now();
      model.set(`${connection.id}_last_activity`, now);
      browser.setCookie('glide_session_store=abc123');
      await connection.connect();

      expect(model.get(`${connection.id}_conn_status`)).toBe('on');

      // Reset spy
      healthChecker.doCheck.calls.reset();

      // Set last activity to be older than validationInterval
      model.set(`${connection.id}_last_activity`, now - validationInterval - 1);
      
      // Make health check pass
      healthChecker.doCheck.and.returnValue(true);

      // Advance time to trigger validation loop
      jasmine.clock().tick(validationInterval + 1);

      // Allow promise from doCheck to settle
      await new Promise((r) => setImmediate(r));

      expect(model.get(`${connection.id}_conn_status`)).toBe('on');
      expect(healthChecker.doCheck).toHaveBeenCalledWith();
    });

    it('should not check health if last activity is recent', async () => {
      connection = new Connection({ instanceUrl: url, validationInterval });

      // Turn connection on
      const now = Date.now();
      model.set(`${connection.id}_last_activity`, now);
      browser.setCookie('glide_session_store=abc123');
      await connection.connect();

      expect(model.get(`${connection.id}_conn_status`)).toBe('on');

      // Reset spy
      healthChecker.doCheck.calls.reset();

      // Update last activity to current time (keep it recent)
      model.set(`${connection.id}_last_activity`, Date.now());
      
      // Advance time by less than validationInterval
      jasmine.clock().tick(validationInterval - 1);

      // Health check should not be called because last activity is recent
      expect(healthChecker.doCheck).not.toHaveBeenCalledWith();
      expect(model.get(`${connection.id}_conn_status`)).toBe('on');
    });

    it('should stop validation loop when connection goes off', async () => {
      connection = new Connection({ instanceUrl: url, validationInterval });

      // Turn connection on
      const now = Date.now();
      model.set(`${connection.id}_last_activity`, now);
      browser.setCookie('glide_session_store=abc123');
      await connection.connect();

      expect(model.get(`${connection.id}_conn_status`)).toBe('on');

      // Reset spy
      healthChecker.doCheck.calls.reset();

      // Disconnect manually
      connection.disconnect();
      expect(model.get(`${connection.id}_conn_status`)).toBe('off');

      // Advance time - validation loop should not run
      const callCountBefore = healthChecker.doCheck.calls.count();
      jasmine.clock().tick(validationInterval + 1);

      expect(healthChecker.doCheck.calls.count()).toBe(callCountBefore);
    });
  });

  describe('Method Q: Disconnecting via disconnect() method', () => {
    it('should set status to "off" when disconnect() is called', (done) => {
      connection = new Connection({ instanceUrl: url, validationInterval });

      // Turn connection on first - set initial cookie (null -> has value turns on)
      browser.setCookie('glide_session_store=abc123');
      
      setTimeout(() => {
        expect(model.get(`${connection.id}_conn_status`)).toBe('on');

        connection.disconnect();

        expect(model.get(`${connection.id}_conn_status`)).toBe('off');
        expect(healthChecker.stopPeriodicCheck).toHaveBeenCalled();
        done();
      }, 10);
    });

    it('should stop validation loop when disconnect() is called', async () => {
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date(1000000));
      connection = new Connection({ instanceUrl: url, validationInterval });

      // Turn connection on
      const now = Date.now();
      model.set(`${connection.id}_last_activity`, now);
      browser.setCookie('glide_session_store=abc123');
      await connection.connect();

      expect(model.get(`${connection.id}_conn_status`)).toBe('on');

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
      connection = new Connection({ instanceUrl: url, validationInterval });

      // Turn on via method A - set initial cookie (null -> has value); then health check runs async
      browser.setCookie('glide_session_store=abc123');
      
      jasmine.clock().tick(10);
      await new Promise((r) => setImmediate(r)); // let doCheck() promise resolve and turn on

      expect(model.get(`${connection.id}_conn_status`)).toBe('on');

      // Reset spy
      healthChecker.doCheck.calls.reset();

      // Set up for method P disconnect
      const now = Date.now();
      model.set(`${connection.id}_last_activity`, now - validationInterval - 1);
      healthChecker.doCheck.and.returnValue(false);

      // Advance time to trigger validation loop
      jasmine.clock().tick(validationInterval + 1);

      // Allow promise from doCheck to settle
      await new Promise((r) => setImmediate(r));

      expect(model.get(`${connection.id}_conn_status`)).toBe('off');
      jasmine.clock().uninstall();
    });

    it('should handle turning on via method B, then off via method Q', async () => {
      connection = new Connection({ instanceUrl: url, validationInterval });

      // Turn on via method B (requires health check to pass)
      browser.setCookie('glide_session_store=abc123');
      healthChecker.doCheck.and.returnValue(true);
      const result = await connection.connect();

      expect(result).toBe(true);
      expect(model.get(`${connection.id}_conn_status`)).toBe('on');

      // Turn off via method Q
      connection.disconnect();

      expect(model.get(`${connection.id}_conn_status`)).toBe('off');
    });

    it('should stay on after cookie changes and rely on health checks for off', (done) => {
      connection = new Connection({ instanceUrl: url, validationInterval });

      // Turn on via method A (domain cookie change + passing health check)
      browser.setCookie('some_cookie=value');
      
      setTimeout(() => {
        expect(model.get(`${connection.id}_conn_status`)).toBe('on');

        // Cookie changes alone should not force off anymore
        browser.removeCookieForDomain(urlDomain);
        
        setTimeout(() => {
          expect(model.get(`${connection.id}_conn_status`)).toBe('on');
          done();
        }, 10);
      }, 10);
    });
  });
});
