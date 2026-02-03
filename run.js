const model = require('model-manager/model');
const { ModelManager } = require('model-manager/model-manager');
const { startMockServiceNow } = require('./mock-servicenow.js');
const { getBrowserProvider } = require('./providers.js');
const { Connection } = require('./connection.js');
const { startBrowserSync } = require('./browserSync.js');

// Update the URL to your ServiceNow instance
const instanceUrl = 'https://dev224422.service-now.com';

// Uncomment the browser you want to use by removing the # at the start of the line.
// If all are commented, Puppeteer will use its bundled Chromium.
let browserPath = null;
// browserPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
browserPath = '/Applications/Firefox.app/Contents/MacOS/firefox';
// browserPath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// browserPath = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

const MONITOR_PORT = 3031;

// Start mock ServiceNow instance (localhost:3099) - shares the same model
startMockServiceNow(model);

// One model manager (monitor) on port 3031
const manager = new ModelManager(MONITOR_PORT, model);
manager.start();
console.log(`Monitor at http://localhost:${MONITOR_PORT}`);

// Connection for the ServiceNow instance (id 0)
const connectionId = 0;
const connection = new Connection({ id: connectionId, instanceUrl });

async function main() {
  const provider = getBrowserProvider();
  provider.setExecutablePath(browserPath);

  const monitorUrl = `http://localhost:${MONITOR_PORT}`;
  console.log('Launching browser...');
  await provider.launch({ initialUrl: monitorUrl });

  const browser = provider.getBrowser();
  const secondPage = await browser.newPage();
  await secondPage.goto(instanceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  startBrowserSync();

  console.log('Browser opened: monitor in first tab, ServiceNow instance in second. Press Ctrl-C to exit.');
}

main().catch((err) => {
  console.error('Failed to launch browser:', err.message);
  process.exit(1);
});
