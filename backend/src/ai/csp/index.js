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

module.exports = { getCsp };
