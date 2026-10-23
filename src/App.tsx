import { useEffect, useMemo, useRef, useState } from 'react';
import { api, auth, ws } from './local-client';
import CloudAgent from './CloudAgent';
import AuthGate from './AuthGate';
import GameIcon from './GameIcon';
import { ActiveSessionCheckpoint, deleteActiveCheckpoint, listActiveCheckpoints, saveActiveCheckpoint } from './localSessionStore';
import { ErrorState, LoadingState, StatusBadge } from './UI';
import { AchievementWall, GamingInsights, GoalHistory } from './EnhancedInsights';
import { AgentHealth, BacklogIntelligence, DataTools, GamingCalendar, GamingHeatmap, SessionHealth } from './RoadmapSuite';
import {
  Activity,
  BarChart3,
  Bell,
  Clock,
  ChevronRight,
  Clock3,
  Gamepad2,
  Library,
  MonitorDown,
  Plus,
  Settings,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  Trophy,
  X,
} from 'lucide-react';

type Game = {
  id: string;
  name: string;
  platform: string;
  status: 'Playing' | 'Backlog' | 'Completed' | 'On Hold';
  hours: number;
  color: string;
  executable?: string;
  iconUrl?: string;
  iconDataUrl?: string;
};

type Session = {
  id: string;
  gameId: string;
  startedAt: string;
  endedAt: string | null;
  duration: number;
  endReason?: string;
  recovered?: boolean;
};

function sessionKey(gameId: string, startedAt: string) {
  return `session-${gameId}-${startedAt}`;
}

const seedGames: Game[] = [];
const seedSessions: Session[] = [];

const readLocal = <T,>(key: string, fallback: T): T => {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
};

function formatHours(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins.toString().padStart(2, '0')}m`;
}

function formatPlaytimeHours(hoursValue: number) {
  const totalMinutes = Math.max(0, Math.round(Number(hoursValue || 0) * 60));
  return formatHours(totalMinutes);
}

function formatDuration(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

type CloudGame = { id: string; name: string; executable?: string; iconUrl?: string; iconDataUrl?: string; platform?: string; status?: Game['status']; hours?: number };
type CloudActive = { gameId: string; gameName: string; startedAt: string; elapsedSeconds?: number };
type CloudCommand = { id: string; type: 'end_game'; game_id: string; requested_at: string };
type CloudLastCommand = { id: string; type: 'end_game'; game_id: string; completed_at: string; ok: boolean; message: string };
type CloudDeviceState = {
  device_id?: string;
  games: CloudGame[];
  sessions: Array<{ id: string; gameId: string; startedAt: string; endedAt?: string | null; durationSeconds?: number; endReason?: string; recovered?: boolean }>;
  active: CloudActive[];
  synced_at: string;
  command?: CloudCommand | null;
  last_command?: CloudLastCommand | null;
};

function MainApp() {
  const [accountUserId, setAccountUserId] = useState('');
  const [accountName, setAccountName] = useState('');
  const [accountEmail, setAccountEmail] = useState('');
  const [pairedDeviceId, setPairedDeviceId] = useState('');
  const [cloudState, setCloudState] = useState<CloudDeviceState | null>(null);
  const [cloudError, setCloudError] = useState('');
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudRealtime, setCloudRealtime] = useState(false);
  const [cloudEnding, setCloudEnding] = useState('');
  const [cloudAction, setCloudAction] = useState('');
  const [pairingCodeInput, setPairingCodeInput] = useState('');
  const [pairingCodeExpiry, setPairingCodeExpiry] = useState('');
  const [pairingDeviceId, setPairingDeviceId] = useState('');
  const [pairingBusy, setPairingBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'error' | 'info' } | null>(null);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [selectedGameId, setSelectedGameId] = useState('');
  const [interruptedSession, setInterruptedSession] = useState<ActiveSessionCheckpoint | null>(null);
  const [recoveredSessions, setRecoveredSessions] = useState<Session[]>([]);
  const [goalMinutes, setGoalMinutes] = useState(() => readLocal('gt-weekly-goal-minutes', 600));
  const [dailyGoalMinutes, setDailyGoalMinutes] = useState(() => readLocal('gt-daily-goal-minutes', 120));
  const [notifications, setNotifications] = useState<Array<{ id: string; message: string; time: string; tone: 'success' | 'error' | 'info' }>>(() => readLocal('gt-notifications', []));
  const [ownedDevices, setOwnedDevices] = useState<Array<{ device_id: string; synced_at: string; online: boolean; game_count: number; active_count: number }>>([]);
  const cloudConnectionRef = useRef<ReturnType<typeof ws.connect> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const previousAgentOnlineRef = useRef<boolean | null>(null);

  const showToast = (message: string, tone: 'success' | 'error' | 'info' = 'success') => {
    setToast({ message, tone });
    const item = { id: `${Date.now()}-${Math.random()}`, message, time: new Date().toISOString(), tone };
    setNotifications(current => [item, ...current].slice(0, 40));
    window.setTimeout(() => setToast(current => current?.message === message ? null : current), 3500);
  };

  useEffect(() => { localStorage.setItem('gt-notifications', JSON.stringify(notifications)); }, [notifications]);
  useEffect(() => { localStorage.setItem('gt-weekly-goal-minutes', JSON.stringify(goalMinutes)); }, [goalMinutes]);
  useEffect(() => { localStorage.setItem('gt-daily-goal-minutes', JSON.stringify(dailyGoalMinutes)); }, [dailyGoalMinutes]);

  const loadCloudState = async (deviceId: string) => {
    setCloudLoading(true);
    try {
      const response = await api.get(`/api/device/owned-state?device_id=${encodeURIComponent(deviceId)}`);
      setCloudState(response.data as CloudDeviceState);
      setCloudError('');
    } catch (error) {
      const value = error as { message?: string; response?: { data?: { error?: string; message?: string }; status?: number } };
      const message = value.response?.data?.error || value.response?.data?.message || value.message || 'Unable to sync the paired Windows PC.';
      setCloudError(message);
    } finally {
      setCloudLoading(false);
    }
  };

  const discoverInstalledAgentCode = async () => {
    const endpoints = ['http://127.0.0.1:27831/api/auto-pair-info', 'http://localhost:27831/api/auto-pair-info'];
    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, { cache: 'no-store' });
        if (!response.ok) continue;
        const info = await response.json() as { device_id?: string; pairing_code?: string | null; pairing_expires_at?: string | null; paired?: boolean };
        const deviceId = String(info.device_id || '').trim();
        if (!deviceId) continue;
        setPairingDeviceId(deviceId);
        if (info.pairing_code) {
          setPairingCodeInput(String(info.pairing_code).replace(/\D/g, '').slice(0, 6));
          setPairingCodeExpiry(info.pairing_expires_at || '');
          setCloudAction('Windows Agent found on this PC. Enter or confirm the 6-digit code to connect it.');
        } else if (info.paired) {
          const owned = await api.get('/api/device/owned-list');
          const devices = Array.isArray(owned.data?.devices) ? owned.data.devices as Array<{ device_id: string; online: boolean }> : [];
          if (devices.some(device => device.device_id === deviceId)) {
            if (accountUserId) localStorage.setItem(`gt-paired-device:${accountUserId}`, deviceId);
            setPairedDeviceId(deviceId);
            setCloudAction('Installed Windows Agent detected and reconnected automatically.');
            return deviceId;
          }
        }
        const owned = await api.get('/api/device/owned-list');
        const devices = Array.isArray(owned.data?.devices) ? owned.data.devices as Array<{ device_id: string; online: boolean }> : [];
        if (devices.some(device => device.device_id === deviceId)) {
          if (accountUserId) localStorage.setItem(`gt-paired-device:${accountUserId}`, deviceId);
          setPairedDeviceId(deviceId);
          setCloudAction('Installed Windows Agent detected and reconnected automatically.');
          return deviceId;
        }
      } catch {
        // The Agent may not be installed/running, or the browser may block localhost access. Continue with normal cloud discovery.
      }
    }
    return '';
  };

  useEffect(() => {
    let cancelled = false;
    auth.getUser().then(user => {
      if (!cancelled && user?.userId) {
        setAccountUserId(user.userId);
        setAccountName(user.name || 'GameTracker user');
        setAccountEmail(user.email || 'Signed-in account');
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!accountUserId) return;
    const userGamesKey = `gt-games:${accountUserId}`;
    const userSessionsKey = `gt-sessions:${accountUserId}`;
    const userDeviceKey = `gt-paired-device:${accountUserId}`;
    setGames(readLocal(userGamesKey, seedGames));
    setSessions(readLocal(userSessionsKey, seedSessions));
    setPairedDeviceId(localStorage.getItem(userDeviceKey) || '');
    listActiveCheckpoints().then(checkpoints => {
      const checkpoint = checkpoints.find(item => item.ownerUserId === accountUserId);
      if (checkpoint) setInterruptedSession(checkpoint);
    }).catch(() => undefined);
  }, [accountUserId]);

  const activeCheckpoint = cloudState?.active?.[0];
  useEffect(() => {
    if (!activeCheckpoint) return;
    const startedAt = activeCheckpoint.startedAt;
    const checkpoint: ActiveSessionCheckpoint = {
      ownerUserId: accountUserId,
      sessionId: sessionKey(activeCheckpoint.gameId, startedAt),
      gameId: activeCheckpoint.gameId,
      gameName: activeCheckpoint.gameName,
      startedAt,
      lastCheckpoint: new Date().toISOString(),
      currentStatus: 'playing',
      accumulatedDurationSeconds: Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)),
      syncStatus: 'pending',
    };
    void saveActiveCheckpoint(checkpoint).catch(() => undefined);
    const timer = window.setInterval(() => {
      void saveActiveCheckpoint({
        ...checkpoint,
        lastCheckpoint: new Date().toISOString(),
        accumulatedDurationSeconds: Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)),
      }).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [activeCheckpoint?.gameId, activeCheckpoint?.startedAt, activeCheckpoint?.gameName]);

  useEffect(() => {
    if (!interruptedSession || !cloudState) return;
    const stillActive = cloudState.active.some(active => sessionKey(active.gameId, active.startedAt) === interruptedSession.sessionId);
    if (stillActive) setInterruptedSession(null);
    const alreadyRecorded = cloudState.sessions.some(session => session.gameId === interruptedSession.gameId && session.startedAt === interruptedSession.startedAt);
    if (alreadyRecorded) {
      void deleteActiveCheckpoint(interruptedSession.sessionId).catch(() => undefined);
      setInterruptedSession(null);
    }
  }, [cloudState, interruptedSession]);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: number | null = null;
    let pollTimer: number | null = null;
    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer !== null || cloudConnectionRef.current) return;
      const delay = Math.min(15000, 1000 * (2 ** Math.min(reconnectAttemptRef.current, 4)));
      reconnectAttemptRef.current += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        if (!cancelled) void start();
      }, delay);
    };
    const start = async () => {
      let deviceId = pairedDeviceId;
      if (!deviceId && accountUserId) {
        deviceId = await discoverInstalledAgentCode();
      }
      if (!deviceId && accountUserId) {
        try {
          const response = await api.get('/api/device/owned-list');
          const devices = Array.isArray(response.data?.devices) ? response.data.devices as Array<{ device_id: string; online: boolean }> : [];
          const preferred = devices.find(device => device.online) || devices[0];
          if (preferred?.device_id) {
            deviceId = preferred.device_id;
            if (accountUserId) localStorage.setItem(`gt-paired-device:${accountUserId}`, deviceId);
            setPairedDeviceId(deviceId);
            setCloudAction('Your paired Windows PC was reconnected automatically.');
          }
        } catch {
          // No cloud-owned device yet; stay in the normal unpaired dashboard.
        }
      }
      if (!deviceId || cancelled) return;
      await loadCloudState(deviceId);
      pollTimer = window.setInterval(() => {
        if (!cancelled) void loadCloudState(deviceId);
      }, 5000);
      if (cancelled || cloudConnectionRef.current) return;
      const conn = ws.connect({ heartbeatIntervalMs: 15000 });
      cloudConnectionRef.current = conn;
      conn.onOpen(() => {
        reconnectAttemptRef.current = 0;
        setCloudRealtime(true);
        setCloudError('');
      });
      conn.onClose(() => {
        setCloudRealtime(false);
        if (cloudConnectionRef.current === conn) cloudConnectionRef.current = null;
        scheduleReconnect();
      });
      conn.onError(() => {
        setCloudRealtime(false);
        scheduleReconnect();
      });
      conn.onMessage(message => {
        if (message?.type !== 'entity.update') return;
        const payload = message.payload;
        if (payload?.entity_type !== 'device' || payload?.entity_id !== deviceId) return;
        const data = payload.data as CloudDeviceState;
        if (data?.device_id === deviceId) {
          setCloudState(data);
          setCloudError('');
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
      setCloudRealtime(true);
    };
    start().catch(error => {
      if (!cancelled) {
        setCloudRealtime(false);
        setCloudError(error instanceof Error ? error.message : 'Realtime connection unavailable.');
        scheduleReconnect();
      }
    });
    return () => {
      cancelled = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (pollTimer !== null) window.clearInterval(pollTimer);
      const conn = cloudConnectionRef.current;
      const connectionId = conn?.connectionId;
      if (connectionId && pairedDeviceId) {
        void api.post('/api/subscriptions/remove', { entity_type: 'device', entity_id: pairedDeviceId, connection_id: connectionId }).catch(() => undefined);
      }
      conn?.disconnect();
      cloudConnectionRef.current = null;
    };
    }, [pairedDeviceId, accountUserId]);

  const endPairedGame = async (game: CloudGame) => {
    if (!pairedDeviceId) return;
    if (!window.confirm(`End ${game.name} on your paired Windows PC?`)) return;
    setCloudEnding(game.id);
    setCloudAction('');
    try {
      await api.post('/api/device/owned-command', { device_id: pairedDeviceId, game_id: game.id });
      setCloudAction(`End-game command sent to ${game.name}.`);
      await loadCloudState(pairedDeviceId);
    } catch (error) {
      const value = error as { message?: string; response?: { status?: number; data?: { error?: string; message?: string } } };
      const status = value.response?.status;
      const message = value.response?.data?.error || value.response?.data?.message || value.message || 'Could not send the end-game command.';
      if (status === 409) {
        await loadCloudState(pairedDeviceId);
        setCloudAction('The previous End Game request is still being processed. Please try again in a moment.');
        showToast('The previous End Game request is still being processed.', 'info');
      } else {
        setCloudAction(message);
        showToast(message, 'error');
      }
    } finally {
      setCloudEnding('');
    }
  };

  const [games, setGames] = useState<Game[]>(seedGames);
  const [sessions, setSessions] = useState<Session[]>(seedSessions);
  const [activeView, setActiveView] = useState('Overview');
  const [showAdd, setShowAdd] = useState(false);
  const [showAgent, setShowAgent] = useState(false);
  const [newGame, setNewGame] = useState({
    name: '',
    executable: '',
    platform: 'PC',
    status: 'Backlog' as Game['status'],
  });
  const [now, setNow] = useState(() => Date.now());

  const signOut = async () => {
    try {
      const conn = cloudConnectionRef.current;
      const connectionId = conn?.connectionId;
      if (connectionId && pairedDeviceId) {
        await api.post('/api/subscriptions/remove', { entity_type: 'device', entity_id: pairedDeviceId, connection_id: connectionId }).catch(() => undefined);
      }
      conn?.disconnect();
      cloudConnectionRef.current = null;
      await auth.signOut();
      setCloudState(null);
      setPairedDeviceId('');
      setShowAccountMenu(false);
      window.location.reload();
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : 'Sign out failed. Please try again.');
    }
  };

  const refreshPairingCode = async () => {
    const endpoints = ['http://127.0.0.1:27831/api/auto-pair-info', 'http://localhost:27831/api/auto-pair-info'];
    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, { cache: 'no-store' });
        if (!response.ok) continue;
        const info = await response.json() as { device_id?: string; pairing_code?: string | null; pairing_expires_at?: string | null };
        const deviceId = String(info.device_id || '').trim();
        if (deviceId && info.pairing_code) {
          setPairingDeviceId(deviceId);
          setPairingCodeInput(String(info.pairing_code).replace(/\D/g, '').slice(0, 6));
          setPairingCodeExpiry(info.pairing_expires_at || '');
          setCloudError('');
          return;
        }
      } catch {
        // Keep the manual paste field available if localhost discovery is unavailable.
      }
    }
    setPairingDeviceId('');
    setPairingCodeInput('');
    setPairingCodeExpiry('');
  };

  const pairFromCode = async () => {
    const code = pairingCodeInput.replace(/\D/g, '').slice(0, 6);
    if (code.length !== 6) {
      setCloudError('Enter the 6-digit pairing code shown in the Windows Agent.');
      return;
    }
    setPairingBusy(true);
    setCloudError('');
    try {
      const response = await api.post('/api/device/pair', { pairing_code: code });
      const deviceId = String(response.data?.device_id || pairingDeviceId || '').trim();
      if (!deviceId) throw new Error('The PC paired successfully, but its device ID was not returned.');
      if (accountUserId) localStorage.setItem(`gt-paired-device:${accountUserId}`, deviceId);
      setPairedDeviceId(deviceId);
      setPairingCodeInput('');
      setPairingCodeExpiry('');
      setCloudError('');
      setCloudAction('Windows PC connected successfully. The pairing code is now invalid.');
      showToast('Windows PC connected successfully.', 'success');
      setShowAgent(false);
    } catch (error) {
      const value = error as { message?: string; response?: { status?: number; data?: { error?: string; message?: string } } };
      const status = value.response?.status;
      const message = status === 401
        ? 'That 6-digit code is invalid, expired, or already used. Check the Windows Agent and enter its current code.'
        : value.response?.data?.error || value.response?.data?.message || value.message || 'PC pairing failed.';
      setCloudError(message);
      showToast(message, 'error');
    } finally {
      setPairingBusy(false);
    }
  };

  useEffect(() => {
    if (!showAgent) return;
    api.get('/api/device/owned-list').then(response => {
      setOwnedDevices(Array.isArray(response.data?.devices) ? response.data.devices : []);
    }).catch(() => setOwnedDevices([]));
    if (!pairedDeviceId) void refreshPairingCode();
  }, [showAgent, pairedDeviceId]);

  useEffect(() => {
    if (!pairedDeviceId && !cloudState?.active?.length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pairedDeviceId, cloudState?.active?.length]);

  useEffect(
    () => {
      if (accountUserId) localStorage.setItem(`gt-games:${accountUserId}`, JSON.stringify(games));
    },
    [games, accountUserId]
  );
  useEffect(
    () => {
      if (accountUserId) localStorage.setItem(`gt-sessions:${accountUserId}`, JSON.stringify(sessions));
    },
    [sessions, accountUserId]
  );

  const displayGames: Game[] = cloudState
    ? cloudState.games.map(game => ({
        id: game.id,
        name: game.name,
        platform: game.platform || 'PC',
        status: cloudState.active.some(active => active.gameId === game.id) ? 'Playing' as const : (game.status || 'Backlog') as Game['status'],
        hours: Number(game.hours || 0),
        color: 'violet',
        executable: game.executable || '',
        iconUrl: game.iconUrl || '',
        iconDataUrl: game.iconDataUrl || ''
      }))
    : games;

  const validationMessage = useMemo(() => {
    const name = newGame.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\\s+/g, ' ').trim();
    const executable = newGame.executable.trim().replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';
    if (!name && !executable) return '';
    const duplicate = displayGames.find(game => {
      const existingName = game.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\\s+/g, ' ').trim();
      const existingExecutable = (game.executable || '').trim().replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';
      return (name && existingName === name) || (executable && existingExecutable === executable);
    });
    if (!duplicate) return '';
    const existingName = duplicate.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\\s+/g, ' ').trim();
    const existingExecutable = (duplicate.executable || '').trim().replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';
    if (name && existingName === name) return `Game already exists: ${duplicate.name}.`;
    return `Executable already registered: ${existingExecutable}.`;
  }, [newGame.name, newGame.executable, displayGames]);

  const displaySessions: Session[] = cloudState
    ? [...cloudState.sessions.map(session => ({
          id: session.id,
          gameId: session.gameId,
          startedAt: session.startedAt,
          endedAt: session.endedAt || null,
          duration: Math.max(0, Math.round(Number(session.durationSeconds || 0) / 60)),
          endReason: session.endReason || '',
          recovered: Boolean(session.recovered || session.endReason === 'agent_restart'),
        })), ...recoveredSessions.filter(local => !cloudState.sessions.some(remote => remote.id === local.id))]
        .filter(session => cloudState.games.some(game => game.id === session.gameId))
    : [...sessions, ...recoveredSessions.filter(local => !sessions.some(session => session.id === local.id))].filter(session => games.some(game => game.id === session.gameId));

  const recoverInterruptedSession = async () => {
    if (!interruptedSession) return;
    const recovered: Session = {
      id: interruptedSession.sessionId,
      gameId: interruptedSession.gameId,
      startedAt: interruptedSession.startedAt,
      endedAt: interruptedSession.lastCheckpoint,
      duration: Math.max(0, Math.round(interruptedSession.accumulatedDurationSeconds / 60)),
      endReason: 'interrupted_recovery',
      recovered: true,
    };
    const alreadyRecorded = displaySessions.some(session => session.id === recovered.id || (session.gameId === recovered.gameId && session.startedAt === recovered.startedAt));
    if (!alreadyRecorded) {
      setRecoveredSessions(current => current.some(session => session.id === recovered.id) ? current : [...current, recovered]);
      setSessions(current => current.some(session => session.id === recovered.id) ? current : [...current, recovered]);
    }
    await deleteActiveCheckpoint(interruptedSession.sessionId).catch(() => undefined);
    setInterruptedSession(null);
    showToast(`${interruptedSession.gameName} session recovered.`, 'success');
  };

  const discardInterruptedSession = async () => {
    if (!interruptedSession) return;
    await deleteActiveCheckpoint(interruptedSession.sessionId).catch(() => undefined);
    setInterruptedSession(null);
    showToast(`${interruptedSession.gameName} interrupted session discarded.`, 'info');
  };

  const totalSessionMinutes = useMemo(() => displaySessions.reduce((sum, session) => sum + session.duration, 0), [displaySessions]);
  const longestSession = useMemo(() => displaySessions.reduce((max, session) => Math.max(max, session.duration), 0), [displaySessions]);
  const averageSession = displaySessions.length ? Math.round(totalSessionMinutes / displaySessions.length) : 0;
  const backlog = displayGames.filter(game => game.status === 'Backlog').length;
  const completed = displayGames.filter(game => game.status === 'Completed').length;
  const recentSessions = displaySessions.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 5);
  const nowDate = new Date(now);
  const todayStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(todayStart.getDate() - ((todayStart.getDay() + 6) % 7));
  const monthStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1);
  const todaySessions = displaySessions.filter(session => new Date(session.startedAt) >= todayStart);
  const weekSessions = displaySessions.filter(session => new Date(session.startedAt) >= weekStart);
  const monthSessions = displaySessions.filter(session => new Date(session.startedAt) >= monthStart);
  const todayMinutes = todaySessions.reduce((sum, session) => sum + session.duration, 0);
  const weekMinutes = weekSessions.reduce((sum, session) => sum + session.duration, 0);
  const monthMinutes = monthSessions.reduce((sum, session) => sum + session.duration, 0);
  const todayGames = new Set(todaySessions.map(session => session.gameId)).size;
  const agentSyncedAt = cloudState?.synced_at ? new Date(cloudState.synced_at).getTime() : 0;
  const agentOnline = Boolean(pairedDeviceId && agentSyncedAt && now - agentSyncedAt < 15000);
  const syncStatus = !pairedDeviceId ? 'No PC paired' : !agentOnline ? 'PC offline' : !cloudRealtime ? 'Syncing' : 'Synced';
  const lastSyncLabel = cloudState?.synced_at ? new Date(cloudState.synced_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : 'Never';
  const dateKeys = Array.from(new Set(displaySessions.map(session => new Date(session.startedAt).toISOString().slice(0, 10)))).sort().reverse();
  let streakDays = 0;
  const streakCursor = new Date(todayStart);
  for (let index = 0; index < 365; index += 1) {
    const key = streakCursor.toISOString().slice(0, 10);
    if (!dateKeys.includes(key)) {
      if (index === 0) {
        streakCursor.setDate(streakCursor.getDate() - 1);
        continue;
      }
      break;
    }
    streakDays += 1;
    streakCursor.setDate(streakCursor.getDate() - 1);
  }
  const hourCounts = Array.from({ length: 24 }, () => 0);
  displaySessions.forEach(session => { hourCounts[new Date(session.startedAt).getHours()] += 1; });
  const peakHour = hourCounts.some(Boolean) ? hourCounts.indexOf(Math.max(...hourCounts)) : -1;
  const peakWindow = peakHour >= 0 ? `${new Date(2000, 0, 1, peakHour).toLocaleTimeString([], { hour: 'numeric' })}–${new Date(2000, 0, 1, (peakHour + 1) % 24).toLocaleTimeString([], { hour: 'numeric' })}` : 'Not enough data';

  useEffect(() => {
    if (!pairedDeviceId) {
      previousAgentOnlineRef.current = null;
      return;
    }
    const previous = previousAgentOnlineRef.current;
    previousAgentOnlineRef.current = agentOnline;
    if (previous === null || previous === agentOnline) return;
    showToast(agentOnline ? 'Your Windows PC is now online.' : 'Your Windows PC is now offline.', agentOnline ? 'success' : 'info');
  }, [agentOnline, pairedDeviceId]);

  const displayGameName = (id: string) =>
    displayGames.find(game => game.id === id)?.name || 'Unknown game';

  const addGame = async () => {
    if (!newGame.name.trim()) return;
    if (pairedDeviceId) {
      if (!newGame.executable.trim()) {
        setCloudAction('Enter the Windows executable so the Agent can detect this game.');
        showToast('Windows executable is required.', 'error');
        return;
      }
      if (validationMessage) {
        setCloudAction(validationMessage);
        showToast(validationMessage, 'error');
        return;
      }
      try {
        await api.post('/api/device/owned-game-command', {
          device_id: pairedDeviceId,
          action: 'add',
          game: { name: newGame.name.trim(), executable: newGame.executable.trim(), platform: 'PC', status: newGame.status, hours: 0 },
        });
        setCloudAction(`${newGame.name.trim()} will be added to the Windows Agent.`);
        setNewGame({ name: '', executable: '', platform: 'PC', status: 'Backlog' });
        setShowAdd(false);
        await loadCloudState(pairedDeviceId);
      } catch (error) {
        const value = error as { message?: string; response?: { data?: { error?: string; message?: string } } };
        setCloudAction(value.response?.data?.error || value.response?.data?.message || value.message || 'Could not add the game to Windows.');
      }
      return;
    }
    if (!newGame.name.trim()) {
      showToast('Enter a game name.', 'error');
      return;
    }
    if (validationMessage) {
      showToast(validationMessage, 'error');
      return;
    }
    setGames(prev => [
      ...prev,
      {
        id: `${Date.now()}`,
        name: newGame.name.trim(),
        platform: newGame.platform,
        status: newGame.status,
        hours: 0,
        color: 'blue',
      },
    ]);
    setNewGame({ name: '', executable: '', platform: 'PC', status: 'Backlog' });
    setShowAdd(false);
  };

  const removeGame = async (id: string) => {
    if (cloudState && pairedDeviceId) {
      const game = cloudState.games.find(item => item.id === id);
      if (!game) return;
      if (!window.confirm(`Remove ${game.name} from the Windows Agent?`)) return;
      try {
        await api.post('/api/device/owned-game-command', { device_id: pairedDeviceId, action: 'remove', game_id: id });
        setCloudAction(`${game.name} removal was sent to the Windows Agent.`);
        await loadCloudState(pairedDeviceId);
      } catch (error) {
        const value = error as { message?: string; response?: { data?: { error?: string; message?: string } } };
        setCloudAction(value.response?.data?.error || value.response?.data?.message || value.message || 'Could not remove the game from Windows.');
      }
      return;
    }
    setGames(prev => prev.filter(game => game.id !== id));
  };

  const disconnectDevice = async () => {
    if (!pairedDeviceId) return;
    if (!window.confirm('Disconnect this Windows PC? Your games, sessions, backlog, and history will remain saved.')) return;
    try {
      await api.post('/api/device/disconnect', { device_id: pairedDeviceId });
      const preservedGames = cloudState?.games.map(game => ({ id: game.id, name: game.name, platform: 'PC', status: 'Backlog' as const, hours: Number(game.hours || 0), color: 'violet' })) || [];
      const preservedSessions = cloudState?.sessions.map(session => ({ id: session.id, gameId: session.gameId, startedAt: session.startedAt, endedAt: session.endedAt || null, duration: Math.max(0, Math.round(Number(session.durationSeconds || 0) / 60)), endReason: session.endReason || '', recovered: Boolean(session.recovered || session.endReason === 'agent_restart') })) || [];
      if (preservedGames.length) setGames(preservedGames);
      if (preservedSessions.length) setSessions(preservedSessions);
      const conn = cloudConnectionRef.current;
      conn?.disconnect();
      cloudConnectionRef.current = null;
      if (accountUserId) localStorage.removeItem(`gt-paired-device:${accountUserId}`);
      setPairedDeviceId('');
      setCloudState(null);
      setCloudRealtime(false);
      setCloudError('');
      setCloudAction('Windows PC disconnected. Your game history was kept.');
      showToast('Windows PC disconnected. Your game history was kept.', 'info');
      void refreshPairingCode();
    } catch (error) {
      const value = error as { message?: string; response?: { data?: { error?: string; message?: string } } };
      const message = value.response?.data?.error || value.response?.data?.message || value.message || 'Could not disconnect the Windows PC.';
      setCloudAction(message);
      showToast(message, 'error');
    }
  };

  const nav = [
    { name: 'Overview', icon: BarChart3 },
    { name: 'Analytics', icon: Activity },
    { name: 'Library', icon: Library },
    { name: 'Sessions', icon: Clock3 },
    { name: 'Backlog', icon: Target },
    { name: 'Goals', icon: Trophy },
  ];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <img src="./resources/app-icon.png" alt="GameTracker app icon" />
          </div>
          <div>
            <strong>GameTracker</strong>
            <span>Local-first gaming</span>
          </div>
        </div>
        <div className="agent-card" onClick={() => setShowAgent(true)}>
          <div className="agent-icon">
            <MonitorDown size={17} />
          </div>
          <div>
            <b>{pairedDeviceId ? 'Windows PC' : 'Desktop Agent'}</b>
            <span>
              <i className={agentOnline ? 'dot connected' : 'dot'} /> {pairedDeviceId ? `${agentOnline ? 'PC online' : 'PC offline'} · ${cloudRealtime ? 'Realtime' : 'Reconnecting'}` : 'Not connected'}
            </span>
          </div>
          <ChevronRight size={16} />
        </div>
        <nav>
          {nav.map(item => {
            const Icon = item.icon;
            return (
              <button
                key={item.name}
                className={
                  activeView === item.name ? 'nav-item active' : 'nav-item'
                }
                onClick={() => setActiveView(item.name)}
              >
                <Icon size={18} />
                {item.name}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => setShowAgent(true)}>
            <Settings size={18} />
            Settings
          </button>
          <div className="privacy">
            <ShieldCheck size={15} />
            <span>
              Your activity stays private
              <br />
              to your signed-in account.
            </span>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <div className="eyebrow">GAMING ACTIVITY</div>
            <h1>{activeView}</h1>
          </div>
              <div className="top-actions">
            <button className="icon-btn notification-button" onClick={() => setShowNotifications(current => !current)} aria-label="Open notifications">
              <Bell size={18} />
              {notifications.length > 0 && <span className="notification-count">{Math.min(99, notifications.length)}</span>}
            </button>
            <button className="add-btn" onClick={() => setShowAdd(true)}>
              <Plus size={18} /> Add game
            </button>
            <div className={`account-menu ${showAccountMenu ? 'open' : ''}`}>
              <button className="account-trigger" type="button" onClick={() => setShowAccountMenu(current => !current)} aria-expanded={showAccountMenu} aria-haspopup="menu" aria-label="Open profile menu">
                <div className="account-avatar">{(accountName || 'G').charAt(0).toUpperCase()}</div>
                <div className="account-copy"><b>{accountName || 'GameTracker user'}</b><span>{accountEmail || 'Signed-in account'}</span></div>
                <span className="account-chevron" aria-hidden="true">⌄</span>
              </button>
              {showAccountMenu && (
                <div className="account-dropdown" role="menu">
                  <div className="account-dropdown-copy"><b>{accountName || 'GameTracker user'}</b><span>{accountEmail || 'Signed-in account'}</span></div>
                  <button className="signout-btn" type="button" role="menuitem" onClick={() => { setShowAccountMenu(false); void signOut(); }}>Logout</button>
                </div>
              )}
            </div>
          </div>
        </header>

        {activeView === 'Overview' && (
          <>
            <section className="hero-row">
              <div className="hero-copy">
                <span className="pill">
                  <span className="pulse" /> Local mode
                </span>
                <h2>
                  Know exactly
                  <br />
                  <em>how you play.</em>
                </h2>
                <p>
                  Track sessions, manage your backlog, and understand your
                  gaming habits. Your data is stored on this device.
                </p>
                <div className="hero-actions">
                  <button
                    className="primary"
                    onClick={() => setShowAgent(true)}
                  >
                    <MonitorDown size={17} /> Connect desktop agent
                  </button>
                  <button
                    className="secondary"
                    onClick={() => setActiveView('Library')}
                  >
                    View library <ChevronRight size={16} />
                  </button>
                </div>
              </div>
              <div className="live-card">
                <div className="live-head">
                  <span>
                    <span className="live-dot" /> LIVE MONITOR
                  </span>
                  <span className="muted">Windows Agent</span>
                </div>
                {cloudState?.active?.length ? (
                  <div className="live-games-stack">
                    {cloudState.active.map(active => {
                      const game = cloudState.games.find(item => item.id === active.gameId);
                      return (
                        <div className="live-game-card" key={active.gameId}>
                          <div className="live-game">
                            <div className="game-icon violet"><GameIcon game={displayGames.find(g => g.id === active.gameId) || { name: active.gameName }} size={24} /></div>
                            <div>
                              <b>{active.gameName}</b>
                              <span>{cloudRealtime ? 'Live from paired Windows PC' : 'Paired PC · syncing'}</span>
                            </div>
                          </div>
                          <div className="timer">
                            {formatDuration(Math.max(0, now - new Date(active.startedAt).getTime()) / 1000)}
                          </div>
                          {game && (
                            <button className="stop-btn" onClick={() => void endPairedGame(game)} disabled={Boolean(cloudEnding === game.id || cloudState.command?.game_id === game.id)}>
                              {cloudState.command?.game_id === game.id ? `Ending ${game.name}…` : cloudEnding === game.id ? 'Sending end-game command…' : `End ${game.name}`}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <>
                    {cloudLoading && pairedDeviceId && !cloudState && <LoadingState label="Syncing your Windows PC…" />}
                    {!cloudLoading && cloudError && pairedDeviceId && !cloudState && <ErrorState message={cloudError} onRetry={() => void loadCloudState(pairedDeviceId)} />}
                    {!cloudLoading && !(cloudError && pairedDeviceId && !cloudState) && <div className="empty-live">
                      <div className="empty-orb"><Clock3 size={24} /></div>
                      <b>{pairedDeviceId ? 'Windows PC is connected' : 'No active session'}</b>
                      <span>{pairedDeviceId ? (cloudError || 'Start a configured game on Windows and it will appear here automatically.') : 'Connect the Windows Agent to automatically detect games.'}</span>
                    </div>}
                  </>
                )}
              </div>
            </section>

            {cloudAction && <div className="paired-action-notice">{cloudAction}</div>}
            {cloudState?.last_command && <div className={`paired-command ${cloudState.last_command.ok ? 'ok' : 'bad'}`}>{cloudState.last_command.ok ? '✓' : '⚠'} {cloudState.last_command.message}</div>}
            <section className="connection-strip" aria-label="Windows Agent connection status">
              <span><i className={agentOnline ? 'device-dot online' : 'device-dot'} /> <b>{pairedDeviceId ? (agentOnline ? 'PC online' : 'PC offline') : 'No PC paired'}</b></span>
              <span><i className={cloudRealtime ? 'device-dot online' : 'device-dot'} /> <b>{syncStatus}</b></span>
              <span>Last sync: <b>{lastSyncLabel}</b></span>
              {pairedDeviceId && !agentOnline && <span className="connection-help">Windows Agent is not reporting recently. Start the Agent or check the PC connection.</span>}
              {pairedDeviceId && agentOnline && !cloudRealtime && <span className="connection-help">Reconnecting to live updates automatically…</span>}
            </section>
            <section className="stats-grid" aria-label="Overview stats">
              <Stat icon={<Clock3 />} label="Today" value={formatHours(todayMinutes)} detail={`${todaySessions.length} sessions · ${todayGames} games`} />
              <Stat icon={<Activity />} label="This week" value={formatHours(weekMinutes)} detail={`${weekSessions.length} sessions`} />
              <Stat icon={<Library />} label="Games" value={displayGames.length.toString()} detail={`${completed} completed`} />
              <Stat icon={<Target />} label="Backlog" value={backlog.toString()} detail="Waiting to be played" />
            </section>

            <section className="content-grid">
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h3>{cloudState ? 'Windows games' : 'Currently playing'}</h3>
                    <span>{cloudState ? 'Synced from your paired Windows PC' : 'Your active games'}</span>
                  </div>
                  <button onClick={() => setActiveView('Library')}>
                    See library <ChevronRight size={15} />
                  </button>
                </div>
                <div className="game-list">
                  {cloudState ? cloudState.games.map(game => {
                    const running = cloudState.active.some(item => item.gameId === game.id);
                    return (
                      <div className="game-row" key={game.id}>
                        <div className="game-icon violet"><GameIcon game={game} size={20} /></div>
                        <div className="game-meta"><b>{game.name}</b><span>{game.executable || 'Windows process'} · {formatPlaytimeHours(Number(game.hours || 0))} played</span></div>
                        <div className="progress-wrap"><div className="progress"><i style={{ width: `${Math.min(100, Math.max(8, Number(game.hours || 0) / 3))}%` }} /></div><span>{running ? 'Playing now' : 'Monitoring'}</span></div>
                        {running && <button className="play-btn" onClick={() => void endPairedGame(game)} disabled={Boolean(cloudEnding || cloudState.command)}>{cloudEnding === game.id ? 'Ending…' : 'End game'}</button>}
                      </div>
                    );
                  }) : null}
                  {!cloudState && games.length === 0 && <EmptyState text="Pair your Windows PC to start tracking games." />}
                  {cloudState && cloudState.games.length === 0 && <EmptyState text="No Windows games are configured yet." />}
                </div>
              </div>
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h3>Recent sessions</h3>
                    <span>Latest activity on this device</span>
                  </div>
                  <button onClick={() => setActiveView('Sessions')}>
                    View all <ChevronRight size={15} />
                  </button>
                </div>
                <div className="session-list">
                  {recentSessions.map(session => (
                    <div className="session-row" key={session.id}>
                      <div className="session-game">
                        <div className="mini-icon"><GameIcon game={displayGames.find(g => g.id === session.gameId) || { name: displayGameName(session.gameId) }} size={16} /></div>
                        <div>
                          <b>{displayGameName(session.gameId)}</b>
                          <span>
                            {new Date(session.startedAt).toLocaleDateString(
                              [],
                              { month: 'short', day: 'numeric' }
                            )}{' '}
                            ·{' '}
                            {new Date(session.startedAt).toLocaleTimeString(
                              [],
                              { hour: 'numeric', minute: '2-digit' }
                            )}
                          </span>
                        </div>
                      </div>
                      <strong>{formatHours(session.duration)}</strong>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="insight">
              <div className="insight-icon"><Sparkles size={19} /></div>
              <div>
                <span>PLAYSTYLE INSIGHT</span>
                <b>{peakHour >= 0 ? `Your most common gaming window starts around ${peakWindow}.` : 'Play a few sessions to unlock your peak gaming window.'}</b>
                <p>{displaySessions.length ? `Based on ${displaySessions.length} recorded sessions. Current streak: ${streakDays} day${streakDays === 1 ? '' : 's'}.` : 'GameTracker builds this insight from your real recorded sessions.'}</p>
              </div>
            </section>
            <GamingInsights games={displayGames} sessions={displaySessions} todayMinutes={todayMinutes} weekMinutes={weekMinutes} monthMinutes={monthMinutes} streakDays={streakDays} goalMinutes={goalMinutes} />
            <AgentHealth online={agentOnline} realtime={cloudRealtime} lastSync={lastSyncLabel} deviceCount={ownedDevices.length || (pairedDeviceId ? 1 : 0)} activeCount={cloudState?.active?.length || 0} onReconnect={() => { setShowAgent(true); void refreshPairingCode(); }} />
            <GamingCalendar sessions={displaySessions} gameName={displayGameName} />
          </>
        )}

        {activeView === 'Analytics' && <><AnalyticsView games={displayGames} sessions={displaySessions} goalMinutes={goalMinutes} totalSessionMinutes={totalSessionMinutes} longestSession={longestSession} averageSession={averageSession} todayMinutes={todayMinutes} weekMinutes={weekMinutes} monthMinutes={monthMinutes} peakWindow={peakWindow} streakDays={streakDays} /><GamingHeatmap sessions={displaySessions} /><DataTools games={displayGames} sessions={displaySessions} /><SessionHealth sessions={displaySessions} games={displayGames} /></>}
        {activeView === 'Library' && <LibraryView games={displayGames} onDelete={removeGame} onSelect={setSelectedGameId} />}
        {activeView === 'Sessions' && <SessionsView sessions={displaySessions} gameName={displayGameName} gamePlatform={id => displayGames.find(game => game.id === id)?.platform || 'Unknown'} deviceLabel={pairedDeviceId ? 'Windows PC' : 'Local'} />}
        {activeView === 'Backlog' && <><BacklogView games={displayGames} /><BacklogIntelligence games={displayGames} sessions={displaySessions} onPick={(id) => setSelectedGameId(id)} /></>}
        {activeView === 'Goals' && <GoalsView goalMinutes={goalMinutes} setGoalMinutes={setGoalMinutes} dailyGoalMinutes={dailyGoalMinutes} setDailyGoalMinutes={setDailyGoalMinutes} todayMinutes={todayMinutes} weekMinutes={weekMinutes} totalSessionMinutes={totalSessionMinutes} sessions={displaySessions} streakDays={streakDays} />}
      </main>


      {showNotifications && <div className="notification-panel"><div className="notification-head"><div><span className="eyebrow">ACTIVITY</span><b>Notifications</b></div><button onClick={() => setNotifications([])}>Clear</button></div>{notifications.length ? notifications.map(item => <div className="notification-item" key={item.id}><span className={`notification-dot ${item.tone}`} /><div><b>{item.message}</b><small>{new Date(item.time).toLocaleString()}</small></div></div>) : <EmptyState text="No notifications yet." />}</div>}
      {selectedGameId && <GameDetailModal game={displayGames.find(game => game.id === selectedGameId) || null} sessions={displaySessions.filter(session => session.gameId === selectedGameId)} onClose={() => setSelectedGameId('')} />}
      {interruptedSession && (
        <Modal title="Interrupted Session Detected" onClose={() => undefined}>
          <div className="recovery-modal">
            <div className="recovery-modal-icon"><Clock3 size={22} /></div>
            <p>GameTracker found an unfinished session for <strong>{interruptedSession.gameName}</strong>.</p>
            <div className="recovery-detail"><span>Last activity</span><strong>{new Date(interruptedSession.lastCheckpoint).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</strong></div>
            <div className="recovery-actions">
              <button className="primary full" type="button" onClick={() => void recoverInterruptedSession()}>Recover session</button>
              <button className="secondary full" type="button" onClick={() => void discardInterruptedSession()}>Discard</button>
            </div>
          </div>
        </Modal>
      )}
      {showAdd && (
        <Modal title="Add a game" onClose={() => setShowAdd(false)}>
          <div className="form">
            {validationMessage && <div className="validation-card error"><span className="validation-badge">!</span><div><b>{validationMessage}</b><small>GameTracker prevents duplicate games and duplicate Windows executables.</small></div></div>}
            {!validationMessage && newGame.name.trim() && newGame.executable.trim() && <div className="validation-card success"><span className="validation-badge">✓</span><div><b>Looks good</b><small>This game is not currently registered in your library.</small></div></div>}
            <label>
              Game name
              <input
                autoFocus
                className={validationMessage && validationMessage.startsWith('Game already') ? 'field-invalid' : ''}
                value={newGame.name}
                onChange={e => setNewGame({ ...newGame, name: e.target.value })}
                placeholder="e.g. Roblox"
              />
            </label>
            <label>
              Windows executable
              <input
                className={validationMessage && validationMessage.startsWith('Executable already') ? 'field-invalid' : ''}
                value={newGame.executable}
                onChange={e => setNewGame({ ...newGame, executable: e.target.value })}
                placeholder="e.g. RobloxPlayerBeta.exe"
              />
            </label>
            <label>
              Platform
              <select
                value={newGame.platform}
                onChange={e =>
                  setNewGame({ ...newGame, platform: e.target.value })
                }
              >
                <option>PC</option>
                <option>PlayStation</option>
                <option>Xbox</option>
                <option>Switch</option>
                <option>Mobile</option>
              </select>
            </label>
            <label>
              Status
              <select
                value={newGame.status}
                onChange={e =>
                  setNewGame({
                    ...newGame,
                    status: e.target.value as Game['status'],
                  })
                }
              >
                <option>Backlog</option>
                <option>Playing</option>
                <option>Completed</option>
                <option>On Hold</option>
              </select>
            </label>
            <button className="primary full" onClick={addGame} disabled={Boolean(validationMessage) || !newGame.name.trim() || (Boolean(pairedDeviceId) && !newGame.executable.trim())}>
              Add to library
            </button>
          </div>
        </Modal>
      )}
      {showAgent && (
        <Modal title={pairedDeviceId ? 'Windows PC' : 'Connect Windows PC'} onClose={() => setShowAgent(false)}>
            <div className="agent-modal">
            <div className="agent-large">
              <MonitorDown size={28} />
            </div>
            <h3>Automatic tracking needs the Windows Agent</h3>
            <p>
              The browser cannot see Windows processes such as VALORANT.exe. A
              lightweight local companion is required for true automatic
              detection.
            </p>
            {ownedDevices.length > 0 && (
              <div className="device-list-panel">
                <div className="eyebrow">YOUR WINDOWS DEVICES</div>
                {ownedDevices.map(device => (
                  <button key={device.device_id} className={device.device_id === pairedDeviceId ? 'device-list-item selected' : 'device-list-item'} onClick={() => { if (accountUserId) localStorage.setItem(`gt-paired-device:${accountUserId}`, device.device_id); setPairedDeviceId(device.device_id); setCloudAction('Switched to this Windows PC.'); }}>
                    <span><i className={device.online ? 'device-dot online' : 'device-dot'} /> Windows PC</span>
                    <small>{device.game_count} games · {device.active_count ? `${device.active_count} running` : 'idle'}</small>
                  </button>
                ))}
              </div>
            )}
            {pairedDeviceId ? (
              <div className="connected-device-panel">
                <div>
                  <span className="eyebrow">PAIRED DEVICE</span>
                  <b>Windows PC</b>
                  <span className="connected-status"><i className={cloudRealtime ? 'dot connected' : 'dot'} /> {cloudRealtime ? 'Connected' : cloudState ? 'Cloud connected' : 'Connecting…'}</span>
                </div>
                  <button className="danger full" onClick={() => void disconnectDevice()}>
                  Disconnect &amp; regenerate pairing code
                </button>
              </div>
            ) : (
              <div className="connected-device-panel">
                <div>
                  <span className="eyebrow">CONNECT WINDOWS PC</span>
                      <b>Connect your Windows PC</b>
                  <span className="connected-status">Enter the 6-digit code shown by the GameTracker Windows Agent.</span>
                </div>
                <input
                  value={pairingCodeInput}
                  onChange={e => setPairingCodeInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  aria-label="6-digit GameTracker pairing code"
                  className="pairing-code-input"
                />
                {pairingCodeExpiry && <span className="connected-status">Code expires {new Date(pairingCodeExpiry).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. The connection will not expire after pairing.</span>}
                {cloudError && <span className="connected-status" style={{ color: '#fda4af' }}>{cloudError}</span>}
                {cloudAction && <span className="connected-status" style={{ color: '#86efac' }}>{cloudAction}</span>}
                <button className="primary full" onClick={() => void pairFromCode()} disabled={pairingBusy || pairingCodeInput.length !== 6}>
                  {pairingBusy ? 'Connecting…' : 'Connect Windows PC'}
                </button>
                <button className="secondary full" onClick={() => void refreshPairingCode()}>
                  Get code from this PC
                </button>
              </div>
            )}
            <div className="agent-steps">
              <div>
                <b>01</b>
                <span>Agent runs quietly on your PC</span>
              </div>
              <div>
                <b>02</b>
                <span>Detects configured game processes</span>
              </div>
              <div>
                <b>03</b>
                <span>Saves sessions locally in the agent database</span>
              </div>
            </div>
            <div className="notice">
              <ShieldCheck size={17} />
              <span>
                No screenshots, keystrokes, microphone, or unrelated app
                activity are collected.
              </span>
            </div>
            <button
              className="secondary full"
              onClick={() => setShowAgent(false)}
            >
              Close
            </button>
          </div>
        </Modal>
      )}
      {showNotifications && <div className="notification-panel"><div className="notification-head"><div><span className="eyebrow">ACTIVITY</span><b>Notifications</b></div><button onClick={() => setNotifications([])}>Clear</button></div>{notifications.length ? notifications.map(item => <div className="notification-item" key={item.id}><span className={`notification-dot ${item.tone}`} /><div><b>{item.message}</b><small>{new Date(item.time).toLocaleString()}</small></div></div>) : <EmptyState text="No notifications yet." />}</div>}
      {selectedGameId && <GameDetailModal game={displayGames.find(game => game.id === selectedGameId) || null} sessions={displaySessions.filter(session => session.gameId === selectedGameId)} onClose={() => setSelectedGameId('')} />}
      {toast && (
        <div className={`toast toast-${toast.tone}`} role="status" aria-live="polite">
          <span className="toast-icon">{toast.tone === 'success' ? '✓' : toast.tone === 'error' ? '!' : 'i'}</span>
          <span>{toast.message}</span>
          <button aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={15} /></button>
        </div>
      )}
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="stat">
      <div className="stat-icon">{icon}</div>
      <span>{label}</span>
      <b>{value}</b>
      <small>{detail}</small>
    </div>
  );
}
export function GameRow({ game }: { game: Game }) {
  return (
    <div className="game-row">
      <div className={`game-icon ${game.color}`}><GameIcon game={game} size={20} /></div>
      <div className="game-meta">
        <b>{game.name}</b>
<span>
  {game.platform} · {formatPlaytimeHours(game.hours)} played
</span>
      </div>
      <div className="progress-wrap">
        <div className="progress">
          <i
            style={{ width: `${Math.min(100, Math.max(8, game.hours / 3))}%` }}
          />
        </div>
        <span>{game.status}</span>
      </div>

    </div>
  );
}
function EmptyState({ text }: { text: string }) {
  return (
    <div className="empty-state">
      <Gamepad2 size={20} />
      <span>{text}</span>
    </div>
  );
}
function LibraryView({ games, onDelete, onSelect }: { games: Game[]; onDelete: (id: string) => void; onSelect: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'All' | Game['status']>('All');
  const [sort, setSort] = useState<'name' | 'playtime' | 'status'>('name');
  const visibleGames = games.filter(game => game.name.toLowerCase().includes(search.toLowerCase()) && (status === 'All' || game.status === status)).slice().sort((a, b) => sort === 'playtime' ? b.hours - a.hours : sort === 'status' ? a.status.localeCompare(b.status) : a.name.localeCompare(b.name));
  return (
    <section className="view-section">
      <div className="section-intro"><div><span className="eyebrow">YOUR COLLECTION</span><h2>Game library</h2><p>{games.length} games · {games.filter(game => game.status === 'Playing').length} currently playing</p></div></div>
      <div className="library-toolbar">
        <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search games…" aria-label="Search games" />
        <select value={status} onChange={event => setStatus(event.target.value as typeof status)} aria-label="Filter games by status"><option>All</option><option>Playing</option><option>Backlog</option><option>Completed</option><option>On Hold</option></select>
        <select value={sort} onChange={event => setSort(event.target.value as typeof sort)} aria-label="Sort games"><option value="name">Name</option><option value="playtime">Most played</option><option value="status">Status</option></select>
      </div>
      <div className="library-grid" aria-label="Game library">
        {visibleGames.map(game => <div className="library-card" key={game.id}><div className={`cover ${game.color}`}><GameIcon game={game} size={34} /></div><div className="library-info"><StatusBadge status={game.status} /><h3>{game.name}</h3><p>{game.platform} · {formatPlaytimeHours(game.hours)} played</p><div className="card-actions"><button className="details-btn" onClick={() => onSelect(game.id)}>View details <ChevronRight size={13} /></button><button className="delete-btn" onClick={() => onDelete(game.id)} aria-label={`Delete ${game.name}`}><Trash2 size={15} /></button></div></div></div>)}
      </div>
      {!visibleGames.length && <EmptyState text="No games match your Library filters." />}
    </section>
  );
}
function AnalyticsView({ games, sessions, goalMinutes, totalSessionMinutes, longestSession, averageSession, todayMinutes, weekMinutes, monthMinutes, peakWindow, streakDays }: { games: Game[]; sessions: Session[]; goalMinutes: number; totalSessionMinutes: number; longestSession: number; averageSession: number; todayMinutes: number; weekMinutes: number; monthMinutes: number; peakWindow: string; streakDays: number }) {
  const ranked = games.slice().sort((a, b) => b.hours - a.hours);
  const maxHours = Math.max(1, ranked[0]?.hours || 1);
  const dailyTrend = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (6 - offset));
    const next = new Date(date);
    next.setDate(next.getDate() + 1);
    const minutes = sessions.filter(session => { const started = new Date(session.startedAt); return started >= date && started < next; }).reduce((sum, session) => sum + session.duration, 0);
    return { label: date.toLocaleDateString([], { weekday: 'short' }), minutes };
  });
  const trendMax = Math.max(1, ...dailyTrend.map(day => day.minutes));
  return <section className="view-section">
    <div className="section-intro"><div><span className="eyebrow">PLAYTIME INTELLIGENCE</span><h2>Gaming analytics</h2><p>Daily, weekly, monthly, and lifetime patterns from your recorded sessions.</p></div></div>
    <div className="analytics-summary"><Stat icon={<Clock />} label="Today" value={formatHours(todayMinutes)} detail="Current day" /><Stat icon={<Activity />} label="This week" value={formatHours(weekMinutes)} detail={`${goalMinutes ? Math.min(100, Math.round(weekMinutes / goalMinutes * 100)) : 0}% of weekly goal`} /><Stat icon={<BarChart3 />} label="This month" value={formatHours(monthMinutes)} detail="Current calendar month" /><Stat icon={<Trophy />} label="Peak window" value={peakWindow} detail={`${streakDays}-day current streak`} /></div>
    <div className="panel trend-panel"><div className="panel-head"><div><h3>Last 7 days</h3><span>Minutes played per day</span></div><strong>{formatHours(totalSessionMinutes)} lifetime · Avg {formatHours(averageSession)} · Longest {formatHours(longestSession)}</strong></div><div className="trend-chart">{dailyTrend.map(day => <div className="trend-day" key={day.label}><div className="trend-track"><i style={{ height: `${Math.max(day.minutes ? 8 : 2, Math.round(day.minutes / trendMax * 100))}%` }} /></div><b>{day.minutes ? formatHours(day.minutes) : '—'}</b><span>{day.label}</span></div>)}</div></div>
    <GamingInsights games={games} sessions={sessions} todayMinutes={todayMinutes} weekMinutes={weekMinutes} monthMinutes={monthMinutes} streakDays={streakDays} goalMinutes={goalMinutes} />
    <div className="analytics-grid"><div className="panel analytics-panel"><div className="panel-head"><div><h3>Most played games</h3><span>Ranked by total playtime</span></div></div><div className="analytics-list">{ranked.slice(0, 8).map((game, index) => <div className="analytics-row" key={game.id}><b>#{index + 1}</b><span>{game.name}</span><div className="analytics-bar"><i style={{ width: `${Math.max(6, Math.min(100, game.hours / maxHours * 100))}%` }} /></div><strong>{formatPlaytimeHours(game.hours)}</strong></div>)}</div></div><AchievementWall games={games} sessions={sessions} totalSessionMinutes={totalSessionMinutes} streakDays={streakDays} /></div>
  </section>;
}
function GoalsView({ goalMinutes, setGoalMinutes, dailyGoalMinutes, setDailyGoalMinutes, todayMinutes, weekMinutes, totalSessionMinutes, sessions, streakDays }: { goalMinutes: number; setGoalMinutes: (value: number) => void; dailyGoalMinutes: number; setDailyGoalMinutes: (value: number) => void; todayMinutes: number; weekMinutes: number; totalSessionMinutes: number; sessions: Session[]; streakDays: number }) {
  const dailyProgress = dailyGoalMinutes ? Math.min(100, Math.round(todayMinutes / dailyGoalMinutes * 100)) : 0;
  const weeklyProgress = goalMinutes ? Math.min(100, Math.round(weekMinutes / goalMinutes * 100)) : 0;
  const achievements = [{ label: '10 sessions', done: sessions.length >= 10 }, { label: '50 sessions', done: sessions.length >= 50 }, { label: '10 hours', done: totalSessionMinutes >= 600 }, { label: '100 hours', done: totalSessionMinutes >= 6000 }, { label: '7-day streak', done: streakDays >= 7 }];
  return <section className="view-section"><div className="section-intro"><div><span className="eyebrow">PLAYTIME TARGETS</span><h2>Goals & achievements</h2><p>Track daily and weekly targets, remaining time, and your activity streak.</p></div></div><div className="goal-grid"><div className="goal-card"><div><span className="eyebrow">DAILY GOAL</span><h3>{formatHours(todayMinutes)} <small>/ {formatHours(dailyGoalMinutes)}</small></h3><div className="goal-progress"><i style={{ width: `${dailyProgress}%` }} /></div><p>{dailyProgress >= 100 ? 'Daily goal reached.' : `${formatHours(Math.max(0, dailyGoalMinutes - todayMinutes))} remaining today.`}</p></div><label>Hours per day<input type="number" min="1" max="24" value={Math.max(1, Math.round(dailyGoalMinutes / 60))} onChange={event => setDailyGoalMinutes(Math.max(60, Math.min(1440, Number(event.target.value || 1) * 60)))} /></label></div><div className="goal-card"><div><span className="eyebrow">WEEKLY GOAL</span><h3>{formatHours(weekMinutes)} <small>/ {formatHours(goalMinutes)}</small></h3><div className="goal-progress"><i style={{ width: `${weeklyProgress}%` }} /></div><p>{weeklyProgress >= 100 ? 'Weekly goal reached.' : `${formatHours(Math.max(0, goalMinutes - weekMinutes))} remaining this week.`}</p></div><label>Hours per week<input type="number" min="1" max="168" value={Math.max(1, Math.round(goalMinutes / 60))} onChange={event => setGoalMinutes(Math.max(60, Math.min(10080, Number(event.target.value || 1) * 60)))} /></label></div></div><div className="goal-streak"><Trophy size={20} /><div><span className="eyebrow">CURRENT STREAK</span><b>{streakDays} day{streakDays === 1 ? '' : 's'}</b><small>Play on consecutive days to grow your streak.</small></div></div><div className="achievement-grid">{achievements.map(item => <div className={item.done ? 'achievement-card unlocked' : 'achievement-card'} key={item.label}><span>{item.done ? '✓' : '○'}</span><div><b>{item.label}</b><small>{item.done ? 'Unlocked' : 'Locked'}</small></div></div>)}</div><GoalHistory sessions={sessions} goalMinutes={goalMinutes} /></section>;
}
function GameDetailModal({ game, sessions, onClose }: { game: Game | null; sessions: Session[]; onClose: () => void }) { const [currentPage, setCurrentPage] = useState(1); const pageSize = 5; useEffect(() => { setCurrentPage(1); }, [game?.id]); if (!game) return null; const total = Math.max(0, Math.round(game.hours * 60)); const longest = sessions.reduce((max, session) => Math.max(max, session.duration), 0); const average = sessions.length ? Math.round(sessions.reduce((sum, session) => sum + session.duration, 0) / sessions.length) : 0; const orderedSessions = sessions.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt)); const totalPages = Math.max(1, Math.ceil(orderedSessions.length / pageSize)); const safePage = Math.min(currentPage, totalPages); const pageStart = (safePage - 1) * pageSize; const paginatedSessions = orderedSessions.slice(pageStart, pageStart + pageSize); return <Modal title={game.name} onClose={onClose}><div className="game-detail"><div className={`detail-cover ${game.color}`}><GameIcon game={game} size={40} /></div><div className="detail-title"><StatusBadge status={game.status} /><h3>{game.name}</h3><p>{game.platform} · {formatHours(total)} total playtime</p></div><div className="detail-stats"><div><span>Sessions</span><b>{sessions.length}</b></div><div><span>Average</span><b>{formatHours(average)}</b></div><div><span>Longest</span><b>{formatHours(longest)}</b></div></div><div className="detail-history"><div className="eyebrow">SESSION HISTORY</div>{paginatedSessions.map(session => <div className="detail-session" key={session.id}><span>{new Date(session.startedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}{session.recovered && <em className="recovery-badge">Recovered</em>}</span><strong>{formatHours(session.duration)}</strong></div>)}{!sessions.length && <EmptyState text="No completed sessions for this game yet." />}{sessions.length > 0 && totalPages > 1 && <div className="detail-pagination" aria-label="Game session history pagination"><button type="button" onClick={() => setCurrentPage(page => Math.max(1, page - 1))} disabled={safePage === 1}>Previous</button><span>Page <b>{safePage}</b> of <b>{totalPages}</b></span><button type="button" onClick={() => setCurrentPage(page => Math.min(totalPages, page + 1))} disabled={safePage === totalPages}>Next</button></div>}</div></div></Modal>; }
function SessionsView({ sessions, gameName, gamePlatform, deviceLabel }: { sessions: Session[]; gameName: (id: string) => string; gamePlatform: (id: string) => string; deviceLabel: string }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'recent' | 'longest' | 'shortest'>('recent');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const pageSize = 15;
  const filtered = sessions.filter(session => {
    const started = new Date(session.startedAt);
    const afterStart = !fromDate || started >= new Date(`${fromDate}T00:00:00`);
    const beforeEnd = !toDate || started <= new Date(`${toDate}T23:59:59`);
    return gameName(session.gameId).toLowerCase().includes(search.toLowerCase()) && afterStart && beforeEnd;
  }).slice().sort((a, b) => sort === 'longest' ? b.duration - a.duration : sort === 'shortest' ? a.duration - b.duration : b.startedAt.localeCompare(a.startedAt));
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageStart = (currentPage - 1) * pageSize;
  const paginatedSessions = filtered.slice(pageStart, pageStart + pageSize);
  const hasFilters = Boolean(search || fromDate || toDate || sort !== 'recent');
  const clearFilters = () => { setSearch(''); setFromDate(''); setToDate(''); setSort('recent'); setCurrentPage(1); };
  useEffect(() => { setCurrentPage(1); }, [search, sort, fromDate, toDate]);
  useEffect(() => { setCurrentPage(page => Math.min(page, totalPages)); }, [totalPages]);
  return <section className="view-section">
    <div className="section-intro"><div><span className="eyebrow">ACTIVITY LOG</span><h2>Session history</h2><p>{filtered.length} matching sessions · 15 per page.</p></div></div>
    <div className="session-toolbar"><input className="session-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search sessions…" aria-label="Search sessions" /><label className="date-filter"><span>From</span><input type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} aria-label="Sessions from date" /></label><label className="date-filter"><span>To</span><input type="date" value={toDate} onChange={event => setToDate(event.target.value)} aria-label="Sessions to date" /></label><select value={sort} onChange={event => setSort(event.target.value as typeof sort)} aria-label="Sort sessions"><option value="recent">Most recent</option><option value="longest">Longest</option><option value="shortest">Shortest</option></select>{hasFilters && <button type="button" className="clear-filters" onClick={clearFilters}>Clear filters</button>}</div>
    {hasFilters && <div className="active-filters" aria-label="Active session filters"><span>Filters:</span>{search && <b>Game: {search}</b>}{fromDate && <b>From: {fromDate}</b>}{toDate && <b>To: {toDate}</b>}{sort !== 'recent' && <b>Sort: {sort === 'longest' ? 'Longest' : 'Shortest'}</b>}</div>}
    <div className="panel full-panel"><div className="table-head session-table"><span>GAME</span><span>DATE</span><span>START</span><span>END</span><span>PLATFORM / DEVICE</span><span>DURATION</span></div>{paginatedSessions.map(session => { const started = new Date(session.startedAt); const ended = session.endedAt ? new Date(session.endedAt) : new Date(started.getTime() + session.duration * 60000); return <button type="button" className="table-row session-table session-row-button" key={session.id} onClick={() => setSelectedSession(session)}><b>{gameName(session.gameId)}{session.recovered && <em className="recovery-badge">Recovered</em>}</b><span>{started.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</span><span>{started.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span><span>{ended.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span><span>{gamePlatform(session.gameId)} · {deviceLabel}</span><strong>{formatHours(session.duration)}</strong></button>; })}{!filtered.length && <EmptyState text="No sessions match your search or date filters." />}</div>
    {filtered.length > 0 && <div className="pagination" aria-label="Session history pagination"><button type="button" onClick={() => setCurrentPage(page => Math.max(1, page - 1))} disabled={currentPage === 1}>Previous</button><span>Page <b>{currentPage}</b> of <b>{totalPages}</b></span><button type="button" onClick={() => setCurrentPage(page => Math.min(totalPages, page + 1))} disabled={currentPage === totalPages}>Next</button></div>}
    {selectedSession && <SessionDetailModal session={selectedSession} gameName={gameName} gamePlatform={gamePlatform} deviceLabel={deviceLabel} onClose={() => setSelectedSession(null)} />}
  </section>;
}
function SessionDetailModal({ session, gameName, gamePlatform, deviceLabel, onClose }: { session: Session; gameName: (id: string) => string; gamePlatform: (id: string) => string; deviceLabel: string; onClose: () => void }) {
  const started = new Date(session.startedAt);
  const ended = session.endedAt ? new Date(session.endedAt) : new Date(started.getTime() + session.duration * 60000);
  const recovered = Boolean(session.recovered || session.endReason === 'agent_restart');
  const reasonLabel = session.endReason === 'agent_restart' ? 'Recovered after Agent restart' : session.endReason === 'process_closed' ? 'Game closed normally' : 'Recorded session';
  return <Modal title="Session details" onClose={onClose}><div className="session-detail-modal"><div className="session-detail-hero"><div className="mini-icon"><Gamepad2 size={20} /></div><div><span className="eyebrow">{recovered ? 'RECOVERED SESSION' : 'RECORDED SESSION'}</span><h3>{gameName(session.gameId)}</h3><p>{gamePlatform(session.gameId)} · {deviceLabel}</p></div></div><div className="session-detail-grid"><div><span>Date</span><b>{started.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</b></div><div><span>Start</span><b>{started.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</b></div><div><span>End</span><b>{ended.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</b></div><div><span>Duration</span><b>{formatHours(session.duration)}</b></div></div><div className={recovered ? 'session-recovery-note recovered' : 'session-recovery-note'}>{recovered ? '✓ ' : '• '}{reasonLabel}{recovered && ' · End time uses the last known Agent heartbeat before the interruption.'}</div><button className="secondary full" type="button" onClick={onClose}>Close</button></div></Modal>;
}
function BacklogView({ games }: { games: Game[] }) {
  const items = games.filter(game => game.status === 'Backlog');
  return (
    <section className="view-section">
      <div className="section-intro">
        <div>
          <span className="eyebrow">NEXT UP</span>
          <h2>Backlog</h2>
          <p>{items.length} games waiting for their first session.</p>
        </div>
        <div className="roulette">
          <Trophy size={18} />
          <span>Random pick</span>
        </div>
      </div>
      {items.length ? (
        <div className="backlog-grid">
          {items.map((game, index) => (
            <div className="backlog-card" key={game.id}>
              <span>#{index + 1}</span>
              <div className={`backlog-icon ${game.color}`}>
                <GameIcon game={game} size={22} />
              </div>
              <div>
                <h3>{game.name}</h3>
                <p>{game.platform} · Ready when you are</p>
              </div>

            </div>
          ))}
        </div>
      ) : (
        <EmptyState text="Your backlog is clear. Nice work." />
      )}
    </section>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function App() {
  if (window.location.hash === '#cloud-agent') return <CloudAgent />;
  return <AuthGate><MainApp /></AuthGate>;
}

export default App;
