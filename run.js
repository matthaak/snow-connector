const { model, ModelManager } = require('observable-state-model');
const { startMockServiceNow } = require('./mock-servicenow.js');
const provider = require('./providers.js').getBrowserProvider();
const { Connection } = require('./connection.js');
const { startBrowserSync } = require('./browserSync.js');

// Demo instance URL (dev tooling only). Override with SNOW_CONNECTOR_DEMO_INSTANCE.
const instanceUrl = process.env.SNOW_CONNECTOR_DEMO_INSTANCE || 'https://your-instance.service-now.com';

// Uncomment one of the below lines to override the default browser selected by snow-connector or set by the
// SNOW_CONNECTOR_BROWSER environment variable.
// provider.setExecutablePath('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
// provider.setExecutablePath('/Applications/Firefox.app/Contents/MacOS/firefox');
// provider.setExecutablePath('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
// provider.setExecutablePath('C:\\Program Files\\Mozilla Firefox\\firefox.exe');

const MONITOR_PORT = 3031;
const monitorUrl = `http://localhost:${MONITOR_PORT}`;

// Start mock ServiceNow instance (localhost:3099) - shares the same model
startMockServiceNow(model);

// One model manager (monitor) on port 3031
const manager = new ModelManager(MONITOR_PORT, model);
manager.start();
console.log(`Monitor at ${monitorUrl}`);

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
