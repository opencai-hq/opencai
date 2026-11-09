-- AlterEnum
ALTER TYPE "CloudServiceProvider" ADD VALUE 'VSPHERE';
ALTER TYPE "CloudServiceProvider" ADD VALUE 'SSH';
ALTER TYPE "CloudServiceProvider" ADD VALUE 'KUBERNETES';

-- Only CloudOps gets the on-prem CLIs: FinOps is never available on-prem.
UPDATE "agent_personas"
SET "allowedBinaries" = ARRAY(SELECT DISTINCT unnest("allowedBinaries" || ARRAY['govc','kubectl','ssh']))
WHERE "mode" = 'CLOUDOPS';
