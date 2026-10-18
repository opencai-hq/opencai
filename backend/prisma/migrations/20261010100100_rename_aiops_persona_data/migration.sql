-- A persona's modeKey is its mode (plus sub-mode) as text, so it does not
-- follow the enum rename on its own.
UPDATE "agent_personas" SET "modeKey" = 'CLOUDOPS' WHERE "modeKey" = 'AIOPS';

-- Seeded persona prompts name the mode; the seed never overwrites an existing
-- row, so bring the stored text in line here.
UPDATE "agent_personas"
SET "systemPrompt" = replace("systemPrompt", 'AIOps', 'CloudOps')
WHERE "systemPrompt" LIKE '%AIOps%';
