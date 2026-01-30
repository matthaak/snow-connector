/**
 * Ensures Mock ServiceNow is running on port 3099 before integration specs run.
 * Throws if the server is not reachable (e.g. run `node run.js` first).
 */

const { execSync } = require('child_process');

const PORT = 3099;
const checkScript =
  "const http=require('http');const r=http.get('http://127.0.0.1:" +
  PORT +
  "/index.do',(res)=>{res.resume();process.exit(res.statusCode===200?0:1);});r.on('error',()=>process.exit(1));r.setTimeout(2000,()=>{r.destroy();process.exit(1);});";

(function checkMockServer() {
  try {
    execSync('node -e ' + JSON.stringify(checkScript), { timeout: 3000, stdio: 'pipe' });
  } catch (e) {
    throw new Error(
      "Mock ServiceNow is not running on port 3099. Run 'node run' first, then run npm test."
    );
  }
})();

module.exports = { PORT };
