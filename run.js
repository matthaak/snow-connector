const model = require('model-manager/model');
const { ModelManager } = require('model-manager/model-manager');

// Parse command-line argument for number of managers (default 0)
const numManagers = parseInt(process.argv[2] || '0', 10);

// Start model managers - all share the same model instance
for (let i = 0; i < numManagers; i++) {
  const port = 3031 + i;
  const manager = new ModelManager(port, model);
  manager.start();
}

if (numManagers > 0) {
  console.log(`Started ${numManagers} model manager(s) on ports ${3031}-${3031 + numManagers - 1}`);
}
console.log('Process running. Waiting for model changes. Press Ctrl-C to exit.');
