// Mirrors the Prisma CloudServiceProvider enum. Adding a provider is a new
// entry here, a new enum value in schema.prisma, and a module in src/ai/csp/.
const CSP = Object.freeze({
  AWS: 'AWS',
  AZURE: 'AZURE',
  GCP: 'GCP',
});

module.exports = { CSP };
