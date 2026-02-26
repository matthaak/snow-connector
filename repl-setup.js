const { model, ModelManager } = require('model-manager');
const { getBrowserProvider } = require('./providers.js');
const { Connection } = require('./connection.js');

const MONITOR_PORT = 3031;
const instanceUrl = 'https://dev224422.service-now.com';

const provider = getBrowserProvider();
provider.setExecutablePath('/Applications/Firefox.app/Contents/MacOS/firefox');

new ModelManager(MONITOR_PORT, model).start();

const connection = new Connection({
  instanceUrl,
  browserProvider: provider,
});

global.model = model;
global.provider = provider;
global.connection = connection;

console.log(`ModelManager listener started at http://localhost:${MONITOR_PORT}`);
console.log(`Connection created for ${instanceUrl}`);
console.log('Globals: model, provider, connection');
