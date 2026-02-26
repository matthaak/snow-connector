const { model, ModelManager } = require('model-manager');
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
const monitorUrl = `http://localhost:${MONITOR_PORT}`;

// Start mock ServiceNow instance (localhost:3099) - shares the same model
startMockServiceNow(model);

// One model manager (monitor) on port 3031
const manager = new ModelManager(MONITOR_PORT, model);
manager.start();
console.log(`Monitor at ${monitorUrl}`);

const provider = getBrowserProvider();
provider.setExecutablePath(browserPath);

// Connection for the ServiceNow instance (id assigned sequentially by Connection).
// Connection launches browser if needed and creates the login/worker tab.
const connection = new Connection({
  instanceUrl,
  browserProvider: provider,
});

async function main() {
  console.log('Launching connection...');
  await connection.ready();

  startBrowserSync();

  console.log('Browser opened on the login/worker tab. Connection remains off until session is detected. Press Ctrl-C to exit.');
}

main().catch((err) => {
  console.error('Failed to launch browser:', err.message);
  process.exit(1);
});
