import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../lib/AuthContext';
import { useToast } from '../../lib/ToastContext';
import { useWorkspace } from '../../lib/WorkspaceContext';
import { useRealtime } from '../../lib/RealtimeContext';
import {
  createChatSession,
  getChatSession,
  listChatSessions,
  sendChatMessage,
  confirmChatMessage,
  cancelChatMessage,
  renameChatSession,
} from '../../lib/chatApi';
import { TopNav } from '../../components/TopNav';
import { OperatorSidebar } from './components/OperatorSidebar';
import { ViewToggle } from './components/ViewToggle';
import { WorkspaceSelectorForm } from './components/WorkspaceSelectorForm';
import { ChatSessionHeader, NewSessionButton } from './components/ChatSessionHeader';
import { CloudOpsScreen } from './components/CloudOpsScreen';
import { cspKind } from '../../lib/csp';
import { FinOpsScreen } from './components/FinOpsScreen';

// The dashboard brings the charting library with it; load it only when opened.
const DashboardScreen = lazy(() =>
  import('./components/dashboard/DashboardScreen').then((m) => ({ default: m.DashboardScreen })),
);

// One open chat per workspace + mode (+ FinOps sub-mode).
function keyFor(workspaceId, mode, subMode) {
  return `${workspaceId}:${mode}:${mode === 'FINOPS' ? subMode || '' : ''}`;
}

function mergeMessages(existing, incoming) {
  const merged = [...existing];
  for (const m of incoming) {
    const idx = merged.findIndex((x) => x.id === m.id);
    if (idx === -1) merged.push(m);
    else merged[idx] = m;
  }
  return merged;
}

export function OperatorPage() {
  const { token } = useAuth();
  const toast = useToast();
  const { workspace, setWorkspace } = useWorkspace();
  // The URL mirrors the open chat: `/operator?session=<id>`. Links (Recent
  // History, Chat History, a pasted URL, back/forward) open a chat through the
  // URL; opening, starting or leaving a chat in the page writes it back.
  // `view=dashboard` (with `mode`) shows the mode's dashboard instead of its chat.
  const [searchParams, setSearchParams] = useSearchParams();
  const openSessionId = searchParams.get('session');
  const view = searchParams.get('view') === 'dashboard' ? 'dashboard' : 'chat';
  const [cloudOrOnPrem, setCloudOrOnPrem] = useState(() => cspKind(workspace?.csp));
  const [editingWorkspace, setEditingWorkspace] = useState(false);
  const [activeMode, setActiveMode] = useState(() =>
    searchParams.get('mode') === 'FINOPS' ? 'FINOPS' : 'CLOUDOPS',
  );
  const [financeSubMode, setFinanceSubMode] = useState(null);
  const [sessionsByKey, setSessionsByKey] = useState({});
  const [messagesBySession, setMessagesBySession] = useState({});
  const [recentSessions, setRecentSessions] = useState([]);
  const [sending, setSending] = useState(false);
  // What the running turn is doing right now ({ text, command?, thinking? }),
  // from the live connection.
  const [liveStatus, setLiveStatus] = useState(null);
  const realtime = useRealtime();

  const recentRequestRef = useRef(0);

  // Recent History follows the selected mode and skips sessions that were
  // opened but never used.
  function refreshRecentSessions() {
    const requestId = ++recentRequestRef.current;
    listChatSessions(token, { pageSize: 30, mode: activeMode, hasMessages: true })
      .then((res) => {
        // Ignore a slower response for a mode the user has already left.
        if (requestId === recentRequestRef.current) setRecentSessions(res.sessions);
      })
      .catch(() => {});
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refreshRecentSessions, [token, activeMode]);

  async function handleRenameSession(sessionId, title) {
    const updated = await renameChatSession(token, sessionId, title);
    setRecentSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, ...updated } : s)));
  }

  const sessionKey = workspace ? keyFor(workspace.id, activeMode, financeSubMode) : null;
  const currentSession = sessionKey ? sessionsByKey[sessionKey] : null;

  // The session id being loaded from the URL. While set, the state -> URL sync
  // below must not overwrite the URL with the (not yet loaded) current chat.
  const loadingSessionIdRef = useRef(null);

  // Changes only the open chat in the URL; the view stays as it is.
  function writeSessionParam(id, options) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set('session', id);
      else next.delete('session');
      return next;
    }, options);
  }

  // URL -> state.
  useEffect(() => {
    if (!openSessionId) {
      // Navigated to plain /operator (e.g. back button): leave the open chat.
      if (sessionKey && currentSession) {
        setSessionsByKey((prev) => ({ ...prev, [sessionKey]: undefined }));
      }
      return;
    }
    if (openSessionId === currentSession?.id) return;

    let cancelled = false;
    loadingSessionIdRef.current = openSessionId;
    getChatSession(token, openSessionId)
      .then(({ messages, ...session }) => {
        if (cancelled) return;
        setWorkspace(session.workspace);
        setEditingWorkspace(false);
        setCloudOrOnPrem(cspKind(session.workspace.csp));
        setActiveMode(session.mode);
        setFinanceSubMode(session.subMode ?? null);
        setSessionsByKey((prev) => ({
          ...prev,
          [keyFor(session.workspace.id, session.mode, session.subMode)]: session,
        }));
        setMessagesBySession((prev) => ({ ...prev, [session.id]: messages }));
      })
      .catch((err) => {
        if (cancelled) return;
        toast.error(err.message || 'Could not open that chat.');
        // Point the URL back at whatever chat is still open.
        writeSessionParam(currentSession?.id ?? null, { replace: true });
      })
      .finally(() => {
        if (!cancelled && loadingSessionIdRef.current === openSessionId) {
          loadingSessionIdRef.current = null;
        }
      });
    return () => {
      cancelled = true;
      if (loadingSessionIdRef.current === openSessionId) loadingSessionIdRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSessionId, token]);

  // State -> URL: whenever the open chat changes (first message creates one,
  // New Session clears it, switching mode shows that mode's chat).
  useEffect(() => {
    if (loadingSessionIdRef.current) return;
    const id = currentSession?.id ?? null;
    // A history entry, so browser back returns to the previous chat.
    if (id !== openSessionId) writeSessionParam(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSession?.id]);

  // A reloaded dashboard has no chat to take its mode from, so the URL carries it.
  useEffect(() => {
    const wanted = view === 'dashboard' ? activeMode : null;
    if (searchParams.get('mode') === wanted) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (wanted) next.set('mode', wanted);
        else next.delete('mode');
        return next;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, activeMode]);

  // A history entry, so browser back returns to the view the Operator left.
  function handleChangeView(nextView) {
    if (nextView === view) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (nextView === 'dashboard') next.set('view', 'dashboard');
      else next.delete('view');
      return next;
    });
  }

  // Sessions are created lazily by the first message (see handleSend), so
  // starting a new one just clears the current chat for this mode.
  // Context-window usage comes back with each reply; keep the open session's
  // copy current so the header ring updates.
  function applyContext(sessionId, context) {
    if (!context) return;
    setSessionsByKey((prev) => {
      const next = { ...prev };
      for (const [key, s] of Object.entries(prev)) {
        if (s?.id === sessionId) {
          next[key] = { ...s, contextTokens: context.tokens, contextWindow: context.window };
        }
      }
      return next;
    });
  }

  function handleNewSession() {
    if (!sessionKey) return;
    setSessionsByKey((prev) => ({ ...prev, [sessionKey]: undefined }));
  }

  // After a failed request the server may still have saved rows (the user's
  // message, steps before the failure); reload so the transcript matches it.
  function resyncMessages(sessionId) {
    getChatSession(token, sessionId)
      .then(({ messages }) => setMessagesBySession((prev) => ({ ...prev, [sessionId]: messages })))
      .catch(() => {});
  }

  // Each step of a turn arrives over the live connection as it is saved: show
  // it at once. `optimisticId` is the placeholder for the Operator's message,
  // which the saved one replaces.
  function liveProgress(sessionId, optimisticId) {
    return (event) => {
      if (event.kind === 'status') {
        setLiveStatus(event);
      } else if (event.kind === 'message') {
        // A saved row means the command that was running has finished.
        setLiveStatus((current) => (current?.command ? null : current));
        setMessagesBySession((prev) => {
          const list = (prev[sessionId] || []).filter(
            (m) => !(optimisticId && event.message.role === 'USER' && m.id === optimisticId),
          );
          return { ...prev, [sessionId]: mergeMessages(list, [event.message]) };
        });
      }
    };
  }

  // A turn keeps running on the server when the connection drops; once it is
  // back, reload the open chat so it shows whatever was saved meanwhile.
  const seenConnectionsRef = useRef(realtime.connections);
  useEffect(() => {
    if (realtime.connections > 1 && realtime.connections !== seenConnectionsRef.current) {
      if (currentSession) resyncMessages(currentSession.id);
    }
    seenConnectionsRef.current = realtime.connections;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realtime.connections]);

  async function handleSend(text) {
    if (!workspace || !sessionKey || sending) return;
    if (activeMode === 'FINOPS' && !financeSubMode) return;

    let session = currentSession;
    if (!session) {
      // Captured now: the Operator may switch modes while this is in flight.
      const key = sessionKey;
      setSending(true);
      try {
        session = await createChatSession(token, {
          workspaceId: workspace.id,
          mode: activeMode,
          subMode: activeMode === 'FINOPS' ? financeSubMode : undefined,
        });
      } catch (err) {
        setSending(false);
        toast.error(err.message || 'Could not start a new chat.');
        return;
      }
      setSessionsByKey((prev) => ({ ...prev, [key]: session }));
    }

    const sessionId = session.id;
    // Shown immediately; replaced by the persisted row the server returns.
    const optimistic = {
      id: `pending-${Date.now()}`,
      role: 'USER',
      kind: 'TEXT',
      content: text,
      createdAt: new Date().toISOString(),
    };
    const withoutOptimistic = (list) => (list || []).filter((m) => m.id !== optimistic.id);
    setMessagesBySession((prev) => ({
      ...prev,
      [sessionId]: [...(prev[sessionId] || []), optimistic],
    }));
    setSending(true);
    try {
      const res = await sendChatMessage(token, sessionId, text, {
        realtime: realtime.client,
        onProgress: liveProgress(sessionId, optimistic.id),
      });
      applyContext(sessionId, res.context);
      setMessagesBySession((prev) => ({
        ...prev,
        [sessionId]: mergeMessages(withoutOptimistic(prev[sessionId]), res.messages),
      }));
      // The first message titles the session and makes it show in history.
      refreshRecentSessions();
    } catch (err) {
      setMessagesBySession((prev) => ({
        ...prev,
        [sessionId]: withoutOptimistic(prev[sessionId]),
      }));
      toast.error(err.message || 'The message could not be sent.');
      resyncMessages(sessionId);
    } finally {
      setSending(false);
      setLiveStatus(null);
    }
  }

  async function handleConfirm(messageId) {
    if (!currentSession) return;
    setSending(true);
    try {
      const res = await confirmChatMessage(token, currentSession.id, messageId, {
        realtime: realtime.client,
        onProgress: liveProgress(currentSession.id),
      });
      applyContext(currentSession.id, res.context);
      setMessagesBySession((prev) => ({
        ...prev,
        [currentSession.id]: mergeMessages(prev[currentSession.id] || [], res.messages),
      }));
    } catch (err) {
      toast.error(err.message || 'The command could not be confirmed.');
      resyncMessages(currentSession.id);
    } finally {
      setSending(false);
      setLiveStatus(null);
    }
  }

  async function handleCancel(messageId) {
    if (!currentSession) return;
    setSending(true);
    try {
      const res = await cancelChatMessage(token, currentSession.id, messageId, {
        realtime: realtime.client,
        onProgress: liveProgress(currentSession.id),
      });
      setMessagesBySession((prev) => ({
        ...prev,
        [currentSession.id]: mergeMessages(prev[currentSession.id] || [], res.messages),
      }));
    } catch (err) {
      toast.error(err.message || 'The command could not be cancelled.');
      resyncMessages(currentSession.id);
    } finally {
      setSending(false);
      setLiveStatus(null);
    }
  }

  // FinOps does not exist for on-prem Workspaces: never leave it selected there.
  const workspaceIsOnPrem = workspace ? cspKind(workspace.csp) === 'onprem' : false;
  useEffect(() => {
    if (workspaceIsOnPrem && activeMode === 'FINOPS') {
      setActiveMode('CLOUDOPS');
      setFinanceSubMode(null);
    }
  }, [workspaceIsOnPrem, activeMode]);

  // Switching pills drops a selected Workspace of the other kind, so the
  // selector shows (filtered to the new kind) instead of a stale chat.
  function handleChangeCloudOrOnPrem(next) {
    if (next === cloudOrOnPrem) return;
    setCloudOrOnPrem(next);
    setEditingWorkspace(false);
    if (workspace && cspKind(workspace.csp) !== next) setWorkspace(null);
    if (activeMode === 'FINOPS' && next === 'onprem') {
      setActiveMode('CLOUDOPS');
      setFinanceSubMode(null);
    }
  }

  function handleSelectMode(mode) {
    setActiveMode(mode);
    if (mode !== 'FINOPS') setFinanceSubMode(null);
  }

  const messages = currentSession ? messagesBySession[currentSession.id] || [] : [];
  const showToggle = workspace && !editingWorkspace;
  const showChatBar = showToggle && view !== 'dashboard';

  return (
    // Full-height shell: the sidebar and the chat section scroll independently.
    <div className="flex h-screen flex-col bg-gray-50 dark:bg-gray-950">
      <TopNav />
      <div className="flex min-h-0 flex-1">
        <OperatorSidebar
          cloudOrOnPrem={cloudOrOnPrem}
          onChangeCloudOrOnPrem={handleChangeCloudOrOnPrem}
          workspace={workspace}
          onEditWorkspace={() => setEditingWorkspace(true)}
          activeMode={activeMode}
          onSelectMode={handleSelectMode}
          recentSessions={recentSessions}
          activeSessionId={currentSession?.id}
          onRenameSession={handleRenameSession}
        />
        <div className="relative flex min-h-0 flex-1 flex-col">
          {/* On the dashboard the switch sits level with the dashboard title,
              clear of the scrollbar. */}
          {showToggle && view === 'dashboard' && (
            <div className="absolute right-6 top-10 z-10">
              <ViewToggle view={view} onChange={handleChangeView} />
            </div>
          )}
          <main
            className={`flex min-h-0 flex-1 flex-col overflow-y-auto px-6 ${showChatBar ? '' : 'pt-10'}`}
          >
            {/* In chat, a solid bar the conversation scrolls under: the open chat's
                session chip on the left, New Session and the Chat/Dashboard switch
                on the right. Nothing floats over the messages. */}
            {showChatBar && (
              <div className="sticky top-0 z-10 -mx-6 mb-6 flex items-center gap-3 bg-gray-50 px-6 pb-3 pt-6 dark:bg-gray-950">
                <div className="min-w-0 flex-1">
                  {currentSession && <ChatSessionHeader session={currentSession} />}
                </div>
                {currentSession && <NewSessionButton onClick={handleNewSession} />}
                <ViewToggle view={view} onChange={handleChangeView} />
              </div>
            )}
            {!workspace || editingWorkspace ? (
              <div className="mx-auto w-full max-w-4xl pb-10">
                <WorkspaceSelectorForm
                  kind={cloudOrOnPrem}
                  onComplete={(ws) => {
                    setWorkspace(ws);
                    setEditingWorkspace(false);
                  }}
                />
              </div>
            ) : view === 'dashboard' ? (
              <Suspense fallback={<p className="text-sm text-gray-400">Loading dashboard…</p>}>
                <DashboardScreen
                  key={`${workspace.id}:${activeMode}`}
                  workspace={workspace}
                  mode={activeMode}
                />
              </Suspense>
            ) : (
              <>
                {activeMode === 'CLOUDOPS' ? (
                  <CloudOpsScreen
                    workspace={workspace}
                    onEditWorkspace={() => setEditingWorkspace(true)}
                    messages={messages}
                    onSend={handleSend}
                    onConfirm={handleConfirm}
                    onCancel={handleCancel}
                    sending={sending}
                    liveStatus={liveStatus}
                  />
                ) : (
                  <FinOpsScreen
                    subMode={financeSubMode}
                    onSelectSubMode={setFinanceSubMode}
                    messages={messages}
                    onSend={handleSend}
                    onConfirm={handleConfirm}
                    onCancel={handleCancel}
                    sending={sending}
                    liveStatus={liveStatus}
                  />
                )}
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
