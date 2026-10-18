import { apiRequest } from './api';

export const listWidgets = (token, { workspaceId, mode }) =>
  apiRequest(`/api/dashboard/widgets?${new URLSearchParams({ workspaceId, mode })}`, { token });

// Asks the AI to build a graph from a plain-language request. Nothing is saved.
export const previewWidget = (token, body) =>
  apiRequest('/api/dashboard/widgets/preview', { method: 'POST', token, body });

export const createWidget = (token, body) =>
  apiRequest('/api/dashboard/widgets', { method: 'POST', token, body });

export const updateWidget = (token, id, body) =>
  apiRequest(`/api/dashboard/widgets/${id}`, { method: 'PATCH', token, body });

export const refreshWidget = (token, id) =>
  apiRequest(`/api/dashboard/widgets/${id}/refresh`, { method: 'POST', token });

// Asks the AI to write a new drawing for a graph, from the data it already has.
export const redrawWidget = (token, id) =>
  apiRequest(`/api/dashboard/widgets/${id}/redraw`, { method: 'POST', token });

export const deleteWidget = (token, id) =>
  apiRequest(`/api/dashboard/widgets/${id}`, { method: 'DELETE', token });
