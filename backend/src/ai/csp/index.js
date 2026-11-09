const { CSP } = require('../../constants/csp');
const aws = require('./aws');
const azure = require('./azure');
const gcp = require('./gcp');

// Everything the agent path needs to know about one cloud provider: its CLI
// binary and sandbox image, how its credentials are validated and handed to the
// CLI, and how its commands are classified.
const CSPS = {
  [CSP.AWS]: aws,
  [CSP.AZURE]: azure,
  [CSP.GCP]: gcp,
};

function getCsp(name) {
  const csp = Object.hasOwn(CSPS, name) ? CSPS[name] : null;
  if (!csp) {
    throw new Error(`Unsupported CSP: ${name}`);
  }
  return csp;
}

// What a provider's classifier needs to know about the Workspace beyond the
// command itself (e.g. the hosts a credential covers). Providers that need none
// do not define `policyContext`.
function policyContextFor(cspName, credential) {
  return getCsp(cspName).policyContext?.(credential) ?? {};
}

// The argv actually handed to the sandbox. A provider whose CLI runs the command
// through a remote shell (SSH) defines `toExecArgv` to quote it; everything that
// executes a policy-approved command MUST go through this.
function execArgvFor(cspName, argv) {
  return getCsp(cspName).toExecArgv?.(argv) ?? argv;
}

module.exports = { getCsp, policyContextFor, execArgvFor };
