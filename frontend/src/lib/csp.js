// The cloud providers a Workspace can be on. The keys mirror
// backend/src/constants/csp.js, and each provider's credential fields mirror its
// schema in backend/src/ai/csp/.
export const CSPS = {
  AWS: {
    label: 'AWS',
    credentialFields: [
      { name: 'accessKeyId', label: 'AWS Access Key ID' },
      { name: 'secretAccessKey', label: 'AWS Secret Access Key', secret: true },
    ],
  },
  AZURE: {
    label: 'Azure',
    credentialFields: [
      { name: 'tenantId', label: 'Directory (tenant) ID' },
      { name: 'clientId', label: 'Application (client) ID' },
      { name: 'clientSecret', label: 'Client secret', secret: true },
      { name: 'subscriptionId', label: 'Subscription ID' },
    ],
  },
  GCP: {
    label: 'Google Cloud',
    credentialFields: [
      { name: 'serviceAccountKey', label: 'Service account key (JSON)', multiline: true },
      { name: 'projectId', label: 'Project ID (optional, defaults to the key’s)', optional: true },
    ],
  },
};

export const CSP_OPTIONS = Object.keys(CSPS);

export const cspLabel = (csp) => CSPS[csp]?.label ?? csp;
