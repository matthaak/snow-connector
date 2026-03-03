/**
 * Public API for snow-connector.
 * Use Connection for instance connectivity; use providers for browser/model/health checker.
 */
const { Connection } = require('./connection.js');
const providers = require('./providers.js');

module.exports = {
  Connection,
  ...providers,
};
