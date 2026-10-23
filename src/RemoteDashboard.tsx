import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Bell, Clock3, Gamepad2, MonitorDown, RefreshCw, ShieldCheck, WifiOff, XCircle } from 'lucide-react';
import { api, ws } from './local-client';

type Game = { id: string; name: string; executable?: string; hours?: number };
type Session = { id: string; gameId: string; startedAt: string; durationSeconds?: number };
type Active = { gameId: string; gameName: string; startedAt: string; elapsedSeconds?: number };
type Command = { id: string; type: 'end_game'; game_id: string; requested_at: string };
type LastCommand = { id: string; type: 'end_game'; game_id: string; completed_at: string; ok: boolean; message: string };
type RemoteState = { device_id?: string; games: Game[]; sessions: Session[]; active: Active[]; synced_at: string; command?: Command | null; last_command?: LastCommand | null };

function formatDuration(seconds: number) {
  const value = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export default function RemoteDashboard() {
  const params = new URLSearchParams(window.location.search);
  const linkDeviceId = params.get('device') || '';
  const linkAccessCode = params.get('access_code') || '';
  const [deviceId, setDeviceId] = useState(() => linkDeviceId || localStorage.getItem('gt-paired-device') || '');
  const [pairing, setPairing] = useState(Boolean(linkDeviceId && linkAccessCode));
  const [state, setState] = useState<RemoteState | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [endingGameId, setEndingGameId] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const connectionRef = useRef<ReturnType<typeof ws.connect> | null>(null);

  const load = async () => {
    if (!deviceId) {
      setErrorMessage('No paired GameTracker PC was found on this account. Open the pairing link from your Windows app.');
      return;
    }
    setRefreshing(true);
    try {
      const response = await api.get(`/api/device/owned-state?device_id=${encodeURIComponent(deviceId)}`);
      setState(response.data as RemoteState);
      setErrorMessage('');
    } catch (error) {
      const value = error as { message?: string; response?: { data?: { error?: string; message?: string }; status?: number } };
      const message = value.response?.data?.error || value.response?.data?.message || value.message || 'Unable to reach the GameTracker cloud service.';
      const status = value.response?.status;
      setErrorMessage(status ? `${message} (HTTP ${status})` : message);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const connectRealtime = async () => {
      if (!deviceId) return;
      if (linkDeviceId && linkAccessCode) {
        setPairing(true);
        try {
          await api.post('/api/device/pair', { device_id: linkDeviceId, access_code: linkAccessCode });
          localStorage.setItem('gt-paired-device', linkDeviceId);
          setDeviceId(linkDeviceId);
          const cleanUrl = new URL(window.location.href);
          cleanUrl.search = '';
          window.history.replaceState({}, '', cleanUrl.toString());
        } catch (error) {
          const value = error as { message?: string; response?: { data?: { error?: string; message?: string } } };
          setErrorMessage(value.response?.data?.error || value.response?.data?.message || value.message || 'PC pairing failed.');
          setPairing(false);
          return;
        } finally {
          setPairing(false);
        }
      }
      await load();
      if (cancelled) return;
      const conn = ws.connect({ heartbeatIntervalMs: 15000 });
      connectionRef.current = conn;
      conn.onOpen(() => setRealtimeConnected(true));
      conn.onClose(() => setRealtimeConnected(false));
      conn.onError(() => setRealtimeConnected(false));
      conn.onMessage(message => {
        if (message?.type !== 'entity.update') return;
        const payload = message.payload;
        if (payload?.entity_type !== 'device' || payload?.entity_id !== deviceId) return;
        const data = payload.data as RemoteState;
        if (data?.device_id === deviceId) {
          setState(data);
          setErrorMessage('');
        }
      });
      await conn.ready;
      if (cancelled) {
        conn.disconnect();
        return;
      }
      const connectionId = conn.connectionId;
      if (!connectionId) throw new Error('Realtime connection did not provide a connection ID.');
      await api.post('/api/subscriptions', { entity_type: 'device', entity_id: deviceId, connection_id: connectionId });
      setRealtimeConnected(true);
    };
    connectRealtime().catch(error => {
      if (!cancelled) {
        setRealtimeConnected(false);
        setErrorMessage(error instanceof Error ? error.message : 'Realtime connection unavailable.');
      }
    });
    return () => {
      cancelled = true;
      const conn = connectionRef.current;
      const connectionId = conn?.connectionId;
      if (connectionId) void api.post('/api/subscriptions/remove', { entity_type: 'device', entity_id: deviceId, connection_id: connectionId }).catch(() => undefined);
      conn?.disconnect();
      connectionRef.current = null;
    };
  }, [deviceId, linkDeviceId, linkAccessCode]);

  const endGame = async (game: Game) => {
    if (!window.confirm(`Close ${game.name} now? This will terminate the running game process on your Windows PC.`)) return;
    setEndingGameId(game.id);
    setActionMessage('');
    try {
      await api.post('/api/device/owned-command', { device_id: deviceId, game_id: game.id });
      setActionMessage(`Close command sent to ${game.name}.`);
      await load();
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : 'Could not send the close command.');
    } finally {
      setEndingGameId('');
    }
  };

  const totalHours = useMemo(() => (state?.games || []).reduce((sum, game) => sum + Number(game.hours || 0), 0), [state]);
  const longest = useMemo(() => (state?.sessions || []).reduce((max, session) => Math.max(max, Number(session.durationSeconds || 0)), 0), [state]);
  const active = state?.active?.[0];
  const pendingGame = state?.games.find(game => game.id === state.command?.game_id);
  const lastGame = state?.games.find(game => game.id === state.last_command?.game_id);

  if (pairing) {
    return <div className="remote-loading"><div><div className="remote-logo">◈</div><h2>Pairing your PC…</h2><p>This Windows PC is being securely linked to your signed-in GameTracker account.</p></div></div>;
  }

  return (
    <div className="remote-shell">
      <aside className="remote-sidebar">
        <div className="remote-brand"><div className="remote-brand-mark"><Gamepad2 size={19} /></div><div><strong>GameTracker</strong><span>Local-first gaming</span></div></div>
        <div className="remote-agent"><div className="remote-agent-icon"><MonitorDown size={16} /></div><div><b>Windows Agent</b><span><i /> {realtimeConnected ? 'Live connection' : 'Cloud connected'}</span></div></div>
        <nav className="remote-nav"><button className="active"><Gamepad2 size={17} /><span>Overview</span></button><button><Activity size={17} /><span>Sessions</span></button><button><MonitorDown size={17} /><span>PC Agent</span></button></nav>
        <div className="remote-privacy"><ShieldCheck size={14} /><span>Your activity stays private to your paired account.</span></div>
      </aside>

      <main className="remote-main">
        <header className="remote-topbar"><div><div className="remote-eyebrow">GAMING ACTIVITY</div><h1>Overview</h1></div><button className="remote-icon-btn" onClick={load} disabled={refreshing}><RefreshCw size={17} /></button></header>

        {errorMessage ? (
          <section className="remote-error"><WifiOff size={22} /><div><h3>Not connected</h3><p>{errorMessage}</p><button onClick={load}>Try again</button></div></section>
        ) : state ? (
          <>
            <section className="remote-hero-row">
              <div className="remote-hero-copy"><span className="remote-pill"><span /> LIVE WINDOWS TRACKING</span><h2>Know exactly<br /><em>how you play.</em></h2><p>Track sessions, monitor your Windows PC, and control a running game from your phone.</p></div>
              <div className="remote-live-card"><div className="remote-live-head"><span><b /> LIVE MONITOR</span><span>Windows Agent</span></div><div className="remote-live-body"><div className="remote-live-game">{active?.gameName || 'No active game'}</div><div className="remote-timer">{active ? formatDuration(Number(active.elapsedSeconds || 0)) : '—'}</div><div className="remote-sync">{realtimeConnected ? '● Live realtime connection' : '○ Reconnecting…'} · {new Date(state.synced_at).toLocaleString()}</div>{active && <button className="remote-end" onClick={() => { const game = state.games.find(item => item.id === active.gameId); if (game) void endGame(game); }} disabled={Boolean(endingGameId || state.command)}><XCircle size={16} />{state.command ? `Closing ${pendingGame?.name || 'game'}…` : endingGameId ? 'Sending close command…' : `End ${active.gameName}`}</button>}</div></div>
            </section>

            {actionMessage && <div className="remote-notice">{actionMessage}</div>}
            {state.last_command && <div className={`remote-command ${state.last_command.ok ? 'ok' : 'bad'}`}>{state.last_command.ok ? '✓' : '⚠'} {lastGame?.name || 'Game'}: {state.last_command.message}</div>}

            <div className="remote-stats"><div><small>Total playtime</small><b>{totalHours.toFixed(1)}h</b></div><div><small>Games</small><b>{state.games.length}</b></div><div><small>Sessions</small><b>{state.sessions.length}</b></div><div><small>Longest</small><b>{formatDuration(longest)}</b></div></div>

            <section className="remote-panel"><div className="remote-panel-head"><div><h3>Tracked games</h3><span>Your configured Windows games</span></div><span>{realtimeConnected ? 'LIVE' : 'SYNCING'}</span></div>{state.games.map(game => { const running = state.active.some(item => item.gameId === game.id); const disabled = Boolean(endingGameId || state.command); return <div className="remote-game-row" key={game.id}><div><b>{game.name}</b><small>{game.executable || ''} · {Number(game.hours || 0).toFixed(1)}h</small></div><div className="remote-actions"><span className="remote-badge">{running ? 'Playing' : 'Monitoring'}</span>{running && <button className="remote-mini-end" onClick={() => void endGame(game)} disabled={disabled}>{endingGameId === game.id ? 'Closing…' : 'End game'}</button>}</div></div>; })}</section>

            <section className="remote-panel"><div className="remote-panel-head"><div><h3>Recent sessions</h3><span>Latest recorded play sessions</span></div></div>{state.sessions.length ? state.sessions.slice(0, 12).map(session => { const game = state.games.find(item => item.id === session.gameId); return <div className="remote-session-row" key={session.id}><div><b>{game?.name || 'Unknown game'}</b><small>{new Date(session.startedAt).toLocaleString()}</small></div><strong>{formatDuration(Number(session.durationSeconds || 0))}</strong></div>; }) : <div className="remote-empty"><Clock3 size={18} /> No completed sessions yet.</div>}</section>
          </>
        ) : <section className="remote-empty remote-empty-card"><Clock3 size={20} /> Loading your GameTracker data…</section>}
      </main>
      <nav className="remote-mobile-nav"><button className="active"><Gamepad2 size={18} /><span>Overview</span></button><button><Activity size={18} /><span>Sessions</span></button><button><MonitorDown size={18} /><span>PC Agent</span></button><button><Bell size={18} /><span>Alerts</span></button></nav>
    </div>
  );
}
