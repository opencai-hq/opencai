-- AlterEnum
ALTER TYPE "CloudServiceProvider" ADD VALUE 'AZURE';
ALTER TYPE "CloudServiceProvider" ADD VALUE 'GCP';

-- Personas list the CLI binaries they may run. Existing rows were seeded with
-- only "aws"; give them the Azure and Google Cloud CLIs too, so a persona that
-- could act on AWS Workspaces can act on the new providers. The Workspace still
-- decides which single binary a session may run.
UPDATE "agent_personas"
SET "allowedBinaries" = "allowedBinaries" || ARRAY(
  SELECT b FROM unnest(ARRAY['az', 'gcloud']) AS b WHERE b <> ALL ("allowedBinaries")
)
WHERE 'aws' = ANY ("allowedBinaries");
