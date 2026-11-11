// Suggested prompts that follow the selected Workspace's provider, so an Azure,
// vSphere, SSH or Kubernetes Workspace is never offered AWS-only chips. The keys
// mirror lib/csp.js. Every suggestion should be answerable with the commands
// that provider's policy allows (see backend/src/ai/csp/).

const CLOUDOPS = {
  AWS: [
    'Create an EC2 instance',
    'Start an EC2 instance',
    'Create EBS volume',
    'Create a new S3 bucket',
  ],
  AZURE: [
    'List my virtual machines',
    'Start a stopped VM',
    'Create a resource group',
    'Create a storage account',
  ],
  GCP: [
    'List Compute Engine instances',
    'Start a stopped VM instance',
    'Create a Cloud Storage bucket',
    'Create a persistent disk',
  ],
  VSPHERE: [
    'List all VMs and their power state',
    'Power on a VM',
    'Take a snapshot of a VM',
    'Show datastore capacity',
  ],
  SSH: [
    'Check disk usage on all servers',
    'Show memory and load on each server',
    'Show recent errors in the system log',
    'Restart a service on a server',
  ],
  KUBERNETES: [
    'List pods that are not running',
    'Show recent warning events',
    'Scale a deployment',
    'Restart a deployment',
  ],
};

const CLOUDOPS_FALLBACK = [
  'List my virtual machines',
  'Show storage volumes and their sizes',
  'Create a new storage bucket',
];

// FinOps is only offered on cloud Workspaces.
const FINOPS = {
  AWS: {
    TAG_COMPLIANCE: [
      'Find resources missing required tags',
      'Show untagged EC2 instances',
      'Apply mandatory tags to a resource',
    ],
    COST_ANALYTICS: [
      'Show service-wise cost breakdown',
      'Report costs by tags for this month without credits',
      'Show me cost trend for last 14 days',
    ],
    WASTE_MANAGEMENT: [
      'Find unused EBS volumes',
      'List idle EC2 instances',
      'Find unattached Elastic IPs',
    ],
    COST_OPTIMISATION: [
      'Suggest EC2 rightsizing opportunities',
      'Find unused Reserved Instances',
      'Recommend Savings Plans',
    ],
  },
  AZURE: {
    TAG_COMPLIANCE: [
      'Find resources missing required tags',
      'Show untagged virtual machines',
      'Apply mandatory tags to a resource group',
    ],
    COST_ANALYTICS: [
      'Show service-wise cost breakdown',
      'Show cost by resource group this month',
      'Show me cost trend for last 14 days',
    ],
    WASTE_MANAGEMENT: [
      'Find unattached managed disks',
      'List deallocated VMs still holding disks',
      'Find unused public IP addresses',
    ],
    COST_OPTIMISATION: [
      'Show Azure Advisor cost recommendations',
      'Suggest VM rightsizing opportunities',
      'Find reservation opportunities',
    ],
  },
  // Billing data exported to BigQuery can't be queried from the sandbox (no bq),
  // so the Cost Analytics chips stick to what gcloud itself can show.
  GCP: {
    TAG_COMPLIANCE: [
      'Find resources missing required labels',
      'Show unlabeled Compute Engine instances',
      'Apply labels to an instance',
    ],
    COST_ANALYTICS: [
      "Show this project's billing account",
      'List budgets and their amounts',
      'Which services are enabled in this project?',
    ],
    WASTE_MANAGEMENT: [
      'Find unattached persistent disks',
      'List stopped VM instances',
      'Find unused static IP addresses',
    ],
    COST_OPTIMISATION: [
      'Show idle VM recommendations',
      'Suggest machine type rightsizing',
      'Find committed use discount opportunities',
    ],
  },
};

const GRAPHS = {
  CLOUDOPS: {
    AWS: ['EC2 instances by state', 'EBS volumes and their sizes', 'How many S3 buckets there are'],
    AZURE: [
      'Virtual machines by power state',
      'Managed disks and their sizes',
      'Storage accounts by location',
    ],
    GCP: [
      'Compute instances by status',
      'Persistent disks and their sizes',
      'Cloud Storage buckets by location',
    ],
    VSPHERE: ['VMs by power state', 'Datastore free vs used space', 'VM count per host'],
    SSH: [
      'Disk usage per filesystem on a server',
      'Running Docker containers on a server',
      'Failed systemd units on a server',
    ],
    KUBERNETES: ['Pods by status', 'Deployments and their ready replicas', 'Pods per namespace'],
  },
  FINOPS: {
    AWS: [
      'Daily cost by service for the last 30 days',
      'Monthly cost for the last 6 months',
      'Total cost this month',
    ],
    AZURE: [
      'Daily cost by service for the last 30 days',
      'Cost by resource group this month',
      'Monthly cost for the last 6 months',
    ],
    GCP: ['Budgets and their amounts'],
  },
};

const GRAPHS_FALLBACK = {
  CLOUDOPS: [
    'Virtual machines by state',
    'Storage volumes and their sizes',
    'How many storage buckets there are',
  ],
  FINOPS: [
    'Daily cost by service for the last 30 days',
    'Monthly cost for the last 6 months',
    'Total cost this month',
  ],
};

const own = (table, key) => (key && Object.hasOwn(table, key) ? table[key] : undefined);

/** CloudOps chat chips for a Workspace's provider. */
export const cloudOpsPrompts = (csp) => own(CLOUDOPS, csp) ?? CLOUDOPS_FALLBACK;

/** FinOps chips for one sub-mode; none for a provider without FinOps (on-prem). */
export const finOpsPrompts = (csp, subMode) => own(own(FINOPS, csp) ?? {}, subMode) ?? [];

/** Example graphs for the dashboard's Add graph dialog. */
export const graphExamples = (csp, mode) =>
  own(own(GRAPHS, mode) ?? {}, csp) ?? own(GRAPHS_FALLBACK, mode) ?? [];
