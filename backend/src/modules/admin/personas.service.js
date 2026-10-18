const prisma = require('../../config/db');
const { DEFAULT_PERSONAS } = require('../../ai/prompts/defaults');

function computeModeKey(mode, subMode) {
  return subMode ? `${mode}_${subMode}` : mode;
}

/**
 * One entry per built-in persona: the stored row where there is one, else the
 * default the agent falls back to. `defaultSystemPrompt` lets the admin screen
 * offer a reset.
 */
async function listPersonas() {
  const rows = await prisma.agentPersona.findMany();
  const byModeKey = new Map(rows.map((row) => [row.modeKey, row]));

  return DEFAULT_PERSONAS.map((fallback) => ({
    ...fallback,
    mutatingCommandCap: null,
    docLookupAllowed: true,
    ...byModeKey.get(fallback.modeKey),
    defaultSystemPrompt: fallback.systemPrompt,
  }));
}

async function upsertPersona(userId, { mode, subMode, systemPrompt, allowedBinaries, mutatingCommandCap, docLookupAllowed }) {
  const modeKey = computeModeKey(mode, subMode);
  const fields = {
    mode,
    subMode: subMode ?? null,
    systemPrompt,
    allowedBinaries,
    mutatingCommandCap: mutatingCommandCap ?? null,
    docLookupAllowed: docLookupAllowed ?? true,
    updatedByUserId: userId,
  };

  return prisma.agentPersona.upsert({
    where: { modeKey },
    update: fields,
    create: { ...fields, modeKey },
  });
}

module.exports = { listPersonas, upsertPersona };
