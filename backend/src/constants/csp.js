// Mirrors the Prisma CloudServiceProvider enum. Adding a provider is a new
// entry here, a new enum value in schema.prisma, and a module in src/ai/csp/.
const CSP = Object.freeze({
  AWS: 'AWS',
  AZURE: 'AZURE',
  GCP: 'GCP',
  VSPHERE: 'VSPHERE',
  SSH: 'SSH',
  KUBERNETES: 'KUBERNETES',
});

// Providers that are customer-operated infrastructure rather than a public
// cloud. FinOps is unavailable for these.
const ON_PREM_CSPS = new Set([CSP.VSPHERE, CSP.SSH, CSP.KUBERNETES]);

const isOnPrem = (csp) => ON_PREM_CSPS.has(csp);

module.exports = { CSP, ON_PREM_CSPS, isOnPrem };
