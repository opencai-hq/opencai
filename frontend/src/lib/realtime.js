import {
  API_BASE_URL,
  ApiError,
  PASSWORD_CHANGE_REQUIRED_EVENT,
  SESSION_EXPIRED_EVENT,
} from './api';

// The Operator's WebSocket. Chat turns and graph building run over it, and the
// backend pushes every step they take while they run (backend
// src/realtime/socketServer.js has the protocol). When the socket is not
// connected, callers fall back to the HTTP routes, which do the same work
// without the live steps.

const CLOSE_UNAUTHENTICATED = 4401;
const CLOSE_FORBIDDEN = 4403;
const MAX_BACKOFF_MS = 30000;

export const CONNECTION_LOST = 'CONNECTION_LOST';

function socketUrl() {
  const base = new URL(API_BASE_URL || window.location.origin, window.location.origin);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = `${base.pathname.replace(/\/$/, '')}/api/ws`;
  return base.toString();
}

// The same window events api.js fires, so the auth layer reacts the same way.
function announce(code) {
  if (code === 'UNAUTHENTICATED') window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  else if (code === 'PASSWORD_CHANGE_REQUIRED') {
    window.dispatchEvent(new Event(PASSWORD_CHANGE_REQUIRED_EVENT));
  }
}

export class RealtimeClient {
  /**
   * @param {{ token: string, onChange: (state: { connected: boolean, connections: number }) => void }} options
   *   `connections` counts successful sign-ins, so a caller can tell a reconnect.
   */
  constructor({ token, onChange }) {
    this.token = token;
    this.onChange = onChange;
    this.socket = null;
    this.connected = false;
    this.connections = 0;
    this.pending = new Map();
    this.nextId = 0;
    this.backoff = 1000;
    this.stopped = false;
    this.retryTimer = null;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.socket?.close(1000);
    this.socket = null;
    this.setConnected(false);
  }

  setConnected(connected) {
    if (connected) this.connections += 1;
    this.connected = connected;
    this.onChange?.({ connected, connections: this.connections });
  }

  connect() {
    let socket;
    try {
      socket = new WebSocket(socketUrl());
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    let ended = false;

    socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token: this.token }));

    socket.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (frame.type === 'auth.ok') {
        this.backoff = 1000;
        this.setConnected(true);
        return;
      }
      if (frame.type === 'auth.error') {
        ended = true;
        announce(frame.error?.code);
        return;
      }

      const request = this.pending.get(frame.id);
      if (!request) return;
      if (frame.type === 'progress') {
        request.onProgress?.(frame.event);
      } else if (frame.type === 'result') {
        this.pending.delete(frame.id);
        request.resolve(frame.data);
      } else if (frame.type === 'error') {
        this.pending.delete(frame.id);
        const { status, code, message } = frame.error ?? {};
        announce(code);
        request.reject(new ApiError(status ?? 500, code ?? 'UNKNOWN_ERROR', message));
      }
    };

    socket.onclose = (event) => {
      if (this.socket === socket) this.socket = null;
      const wasConnected = this.connected;
      if (wasConnected) this.setConnected(false);

      // The work behind an open request carries on and is saved on the server;
      // only its live steps are lost. Callers reload what it saved.
      for (const request of this.pending.values()) {
        request.reject(
          new ApiError(
            0,
            CONNECTION_LOST,
            'The live connection dropped. The request may still finish on the server.',
          ),
        );
      }
      this.pending.clear();

      const signedOut =
        ended || event.code === CLOSE_UNAUTHENTICATED || event.code === CLOSE_FORBIDDEN;
      if (!this.stopped && !signedOut) this.scheduleRetry();
    };
  }

  scheduleRetry() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  /**
   * Run one action over the socket.
   *
   * @param {(event: { kind: 'message', message } | { kind: 'status', text }) => void} [onProgress]
   * @returns {Promise<any>} what the matching HTTP route would return.
   */
  request(action, payload, onProgress) {
    if (!this.connected || !this.socket) {
      return Promise.reject(new ApiError(0, CONNECTION_LOST, 'Not connected.'));
    }
    this.nextId += 1;
    const id = `r${this.nextId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.socket.send(JSON.stringify({ id, type: 'request', action, payload }));
    });
  }
}

/**
 * Run an action over the socket when it is connected, otherwise over HTTP.
 * Either way the result is the same; only the socket reports live steps.
 */
export function viaRealtime(realtime, action, payload, onProgress, overHttp) {
  if (realtime?.connected) return realtime.request(action, payload, onProgress);
  return overHttp();
}
