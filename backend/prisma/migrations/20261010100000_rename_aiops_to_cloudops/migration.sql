-- AlterEnum
-- The AIOps mode is now called CloudOps. Renaming the value in place carries
-- every chat session and persona that already uses it.
ALTER TYPE "ChatMode" RENAME VALUE 'AIOPS' TO 'CLOUDOPS';
