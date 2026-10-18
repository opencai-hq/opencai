const prisma = require('../config/db');
const envelope = require('../crypto/envelope');
const { AppError } = require('../middleware/errorHandler');
const { ERROR_CODES } = require('../constants/errors');
const { getProvider } = require('./providers');
const { DEFAULT_REQUEST_LIMITS } = require('./settingsDefaults');

/**
 * Resolve the singleton ChatSettings row into everything one orchestration turn
 * needs from it: a live provider module, the model/API key, and the sandbox
 * timeouts.
 */
async function resolveProviderConfig() {
  const settings = await prisma.chatSettings.findFirst();
  if (!settings || !settings.provider || !settings.providerApiKeyEncrypted) {
    throw new AppError(503, ERROR_CODES.AI_PROVIDER_NOT_CONFIGURED);
  }

  const apiKey = envelope.decrypt(settings.providerApiKeyEncrypted);
  const provider = getProvider(settings.provider);

  return {
    provider,
    providerName: settings.provider,
    model: settings.model,
    apiKey,
    baseUrl: settings.baseUrl || undefined,
    config: settings.config || undefined,
    sandboxCommandTimeoutSeconds: settings.sandboxCommandTimeoutSeconds,
    sandboxIdleTimeoutMinutes: settings.sandboxIdleTimeoutMinutes,
    limits: requestLimits(settings.config),
  };
}

function requestLimits(config) {
  const positive = (value, fallback) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  return {
    ...DEFAULT_REQUEST_LIMITS,
    toolOutputChars: positive(config?.tool_output_chars, DEFAULT_REQUEST_LIMITS.toolOutputChars),
    historyChars: positive(config?.history_chars, DEFAULT_REQUEST_LIMITS.historyChars),
  };
}

module.exports = { resolveProviderConfig };
