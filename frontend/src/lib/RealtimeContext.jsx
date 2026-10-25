import { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import { RealtimeClient } from './realtime';

const RealtimeContext = createContext({ client: null, connected: false, connections: 0 });

/**
 * Keeps the Operator's WebSocket open while an Operator is signed in, and
 * closes it on sign-out. Other roles have nothing to run over it.
 */
export function RealtimeProvider({ children }) {
  const { token, user } = useAuth();
  const [state, setState] = useState({ client: null, connected: false, connections: 0 });
  const isOperator = user?.role === 'OPERATOR';

  useEffect(() => {
    if (!token || !isOperator) return undefined;
    const client = new RealtimeClient({
      token,
      onChange: ({ connected, connections }) => setState({ client, connected, connections }),
    });
    setState({ client, connected: false, connections: 0 });
    client.start();
    return () => {
      client.stop();
      setState({ client: null, connected: false, connections: 0 });
    };
  }, [token, isOperator]);

  return <RealtimeContext.Provider value={state}>{children}</RealtimeContext.Provider>;
}

/**
 * @returns {{ client: ?RealtimeClient, connected: boolean, connections: number }}
 *   `connections` goes up on every successful (re)connect.
 */
export function useRealtime() {
  return useContext(RealtimeContext);
}
