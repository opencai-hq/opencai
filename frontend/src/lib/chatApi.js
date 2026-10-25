import { apiRequest } from './api';
import { viaRealtime } from './realtime';

export const createChatSession = (token, body) =>
  apiRequest('/api/chat/sessions', { method: 'POST', token, body });

export const listChatSessions = (token, params = {}) => {
  const query = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')),
  ).toString();
  return apiRequest(`/api/chat/sessions${query ? `?${query}` : ''}`, { token });
};

export const getChatSession = (token, id) => apiRequest(`/api/chat/sessions/${id}`, { token });

export const renameChatSession = (token, id, title) =>
  apiRequest(`/api/chat/sessions/${id}`, { method: 'PATCH', token, body: { title } });

// The three calls that run a chat turn go over the live connection when it is
// open, so `onProgress` sees each step as it happens; otherwise over HTTP.

export const sendChatMessage = (token, sessionId, text, { realtime, onProgress } = {}) =>
  viaRealtime(realtime, 'chat.send', { sessionId, text }, onProgress, () =>
    apiRequest(`/api/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      token,
      body: { text },
    }),
  );

export const confirmChatMessage = (token, sessionId, messageId, { realtime, onProgress } = {}) =>
  viaRealtime(realtime, 'chat.confirm', { sessionId, messageId }, onProgress, () =>
    apiRequest(`/api/chat/sessions/${sessionId}/messages/${messageId}/confirm`, {
      method: 'POST',
      token,
    }),
  );

export const cancelChatMessage = (token, sessionId, messageId, { realtime, onProgress } = {}) =>
  viaRealtime(realtime, 'chat.cancel', { sessionId, messageId }, onProgress, () =>
    apiRequest(`/api/chat/sessions/${sessionId}/messages/${messageId}/cancel`, {
      method: 'POST',
      token,
    }),
  );
