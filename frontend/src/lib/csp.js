// The providers a Workspace can be on. The keys mirror backend/src/constants/csp.js,
// and each provider's credential fields mirror its schema in backend/src/ai/csp/.
// A field's `type` is 'text' (default), 'checkbox' or 'hostList'; `help` is small
// grey text shown under the field.
export const CSPS = {
  AWS: {
    label: 'AWS',
    kind: 'cloud',
    credentialFields: [
      { name: 'accessKeyId', label: 'AWS Access Key ID' },
      { name: 'secretAccessKey', label: 'AWS Secret Access Key', secret: true },
    ],
  },
  AZURE: {
    label: 'Azure',
    kind: 'cloud',
    credentialFields: [
      { name: 'tenantId', label: 'Directory (tenant) ID' },
      { name: 'clientId', label: 'Application (client) ID' },
      { name: 'clientSecret', label: 'Client secret', secret: true },
      { name: 'subscriptionId', label: 'Subscription ID' },
    ],
  },
  GCP: {
    label: 'Google Cloud',
    kind: 'cloud',
    credentialFields: [
      { name: 'serviceAccountKey', label: 'Service account key (JSON)', multiline: true },
      { name: 'projectId', label: 'Project ID (optional, defaults to the key’s)', optional: true },
    ],
  },
  VSPHERE: {
    label: 'VMware vSphere',
    kind: 'onprem',
    credentialFields: [
      { name: 'url', label: 'vCenter URL (https://…)' },
      { name: 'username', label: 'Username' },
      { name: 'password', label: 'Password', secret: true },
      {
        name: 'insecure',
        label: 'Skip TLS verification (self-signed certificate)',
        type: 'checkbox',
      },
      { name: 'datacenter', label: 'Datacenter (optional)', optional: true },
    ],
  },
  SSH: {
    label: 'Linux servers (SSH)',
    kind: 'onprem',
    credentialFields: [
      { name: 'username', label: 'Username' },
      {
        name: 'privateKey',
        label: 'Private key',
        multiline: true,
        help: 'Unencrypted private key (no passphrase). Use a dedicated deploy key.',
      },
      { name: 'hosts', label: 'Servers', type: 'hostList' },
      {
        name: 'knownHosts',
        label: 'known_hosts (optional)',
        multiline: true,
        optional: true,
        help: 'Recommended. Paste known_hosts lines for these servers (ssh-keyscan output). Without them, each new session trusts the server key on first connect.',
      },
    ],
  },
  KUBERNETES: {
    label: 'Kubernetes',
    kind: 'onprem',
    credentialFields: [
      {
        name: 'kubeconfig',
        label: 'Kubeconfig',
        multiline: true,
        help: 'Single-context kubeconfig with embedded credentials (token or client certificate data). exec plugins are not supported.',
      },
      { name: 'namespace', label: 'Namespace (optional)', optional: true },
    ],
  },
};

export const CSP_OPTIONS = Object.keys(CSPS);

export const cspLabel = (csp) => CSPS[csp]?.label ?? csp;

export const cspKind = (csp) => CSPS[csp]?.kind ?? 'cloud';

export const CSP_OPTIONS_BY_KIND = {
  cloud: CSP_OPTIONS.filter((csp) => CSPS[csp].kind === 'cloud'),
  onprem: CSP_OPTIONS.filter((csp) => CSPS[csp].kind === 'onprem'),
};

export const accountLabel = (csp) => (cspKind(csp) === 'onprem' ? 'Site / Cluster' : 'Account');
