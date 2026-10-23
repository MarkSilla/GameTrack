import { Activity, BarChart3, CalendarDays, Clock3, Flame, Gamepad2, Trophy } from 'lucide-react';

type Game = { id: string; name: string; platform: string; status: string; hours: number };
type Session = { id: string; gameId: string; startedAt: string; duration: number };

function hours(minutes: number) {
  const safe = Math.max(0, Math.round(minutes));
  return `${Math.floor(safe / 60)}h ${String(safe % 60).padStart(2, '0')}m`;
}

function weekStart(date: Date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  value.setDate(value.getDate() - ((value.getDay() + 6) % 7));
  return value;
}

export function GamingInsights({ games, sessions, todayMinutes, weekMinutes, monthMinutes, streakDays, goalMinutes }: { games: Game[]; sessions: Session[]; todayMinutes: number; weekMinutes: number; monthMinutes: number; streakDays: number; goalMinutes: number }) {
  const now = new Date();
  const currentWeek = weekStart(now);
  const previousWeekStart = new Date(currentWeek);
  previousWeekStart.setDate(previousWeekStart.getDate() - 7);
  const previousWeekEnd = new Date(currentWeek);
  const previousWeekMinutes = sessions.filter(session => { const d = new Date(session.startedAt); return d >= previousWeekStart && d < previousWeekEnd; }).reduce((sum, s) => sum + s.duration, 0);
  const change = previousWeekMinutes ? Math.round(((weekMinutes - previousWeekMinutes) / previousWeekMinutes) * 100) : null;
  const ranked = games.slice().sort((a, b) => b.hours - a.hours);
  const topGame = ranked[0];
  const avg = sessions.length ? Math.round(sessions.reduce((sum, s) => sum + s.duration, 0) / sessions.length) : 0;
  const activeDays = new Set(sessions.filter(s => new Date(s.startedAt) >= currentWeek).map(s => new Date(s.startedAt).toDateString())).size;
  const goalPct = goalMinutes ? Math.min(100, Math.round((weekMinutes / goalMinutes) * 100)) : 0;
  return <section className="insights-suite" aria-label="Gaming insights">
    <div className="insights-suite-head"><div><span className="eyebrow">GAMING INSIGHTS</span><h3>How your week is shaping up</h3><p>Real patterns from your recorded sessions — no estimates.</p></div><div className="insight-week-chip"><CalendarDays size={14} /> {activeDays} active day{activeDays === 1 ? '' : 's'}</div></div>
    <div className="insight-metrics">
      <div><span><Activity size={13} /> WEEK VS LAST</span><b>{change === null ? 'New' : `${change >= 0 ? '+' : ''}${change}%`}</b><small>{previousWeekMinutes ? `${hours(weekMinutes)} vs ${hours(previousWeekMinutes)}` : 'Keep tracking to unlock comparison'}</small></div>
      <div><span><Gamepad2 size={13} /> MOST PLAYED</span><b>{topGame?.name || '—'}</b><small>{topGame ? `${topGame.hours.toFixed(1)}h lifetime` : 'No game data yet'}</small></div>
      <div><span><Clock3 size={13} /> AVG SESSION</span><b>{avg ? hours(avg) : '—'}</b><small>{sessions.length} recorded session{sessions.length === 1 ? '' : 's'}</small></div>
      <div><span><Flame size={13} /> STREAK</span><b>{streakDays} day{streakDays === 1 ? '' : 's'}</b><small>{streakDays >= 7 ? 'One week unlocked' : 'Play on consecutive days'}</small></div>
    </div>
    <div className="insight-goal-row"><div><b>{hours(weekMinutes)}</b><span> of {hours(goalMinutes)} weekly goal</span></div><strong>{goalPct}%</strong></div>
    <div className="insight-goal-track"><i style={{ width: `${goalPct}%` }} /></div>
    <div className="insight-summary"><BarChart3 size={15} /><span>{monthMinutes ? `You've logged ${hours(monthMinutes)} this month. ${todayMinutes ? `Today: ${hours(todayMinutes)}.` : 'No playtime logged today yet.'}` : 'Start a session to build your monthly pattern.'}</span></div>
  </section>;
}

export function AchievementWall({ sessions, totalSessionMinutes, streakDays, games }: { sessions: Session[]; totalSessionMinutes: number; streakDays: number; games: Game[] }) {
  const unlocked = [
    sessions.length >= 1,
    sessions.length >= 10,
    sessions.length >= 50,
    totalSessionMinutes >= 600,
    totalSessionMinutes >= 6000,
    streakDays >= 7,
    games.length >= 10,
    games.filter(g => g.status === 'Completed').length >= 1,
  ];
  const labels = ['First session', '10 sessions', '50 sessions', '10 hours', '100 hours', '7-day streak', '10 games', 'First completion'];
  return <section className="achievement-wall"><div className="panel-head"><div><h3>Achievement shelf</h3><span>{unlocked.filter(Boolean).length} of {labels.length} unlocked</span></div><Trophy size={17} /></div><div className="achievement-wall-grid">{labels.map((label, index) => <div className={unlocked[index] ? 'wall-badge unlocked' : 'wall-badge'} key={label}><span>{unlocked[index] ? '✓' : '○'}</span><b>{label}</b><small>{unlocked[index] ? 'Unlocked' : 'Locked'}</small></div>)}</div></section>;
}

export function GoalHistory({ sessions, goalMinutes }: { sessions: Session[]; goalMinutes: number }) {
  const weeks = Array.from({ length: 4 }, (_, index) => {
    const start = weekStart(new Date());
    start.setDate(start.getDate() - (3 - index) * 7);
    const end = new Date(start); end.setDate(end.getDate() + 7);
    const minutes = sessions.filter(s => { const d = new Date(s.startedAt); return d >= start && d < end; }).reduce((sum, s) => sum + s.duration, 0);
    return { label: start.toLocaleDateString([], { month: 'short', day: 'numeric' }), minutes };
  });
  const max = Math.max(goalMinutes, ...weeks.map(w => w.minutes), 1);
  return <section className="goal-history panel"><div className="panel-head"><div><h3>Goal history</h3><span>Last 4 calendar weeks</span></div><span className="goal-history-target">Target {hours(goalMinutes)}</span></div><div className="goal-history-grid">{weeks.map(week => <div key={week.label}><div className="goal-history-track"><i style={{ height: `${Math.max(3, Math.round((week.minutes / max) * 100))}%` }} /></div><b>{week.minutes ? hours(week.minutes) : '—'}</b><small>{week.label}</small></div>)}</div></section>;
}
