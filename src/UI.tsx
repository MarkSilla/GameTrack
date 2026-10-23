import { AlertCircle, CheckCircle2, Info, LoaderCircle } from 'lucide-react';

type Status = 'Playing' | 'Backlog' | 'Completed' | 'On Hold' | 'Online' | 'Offline' | 'Synced' | 'Syncing';

export function StatusBadge({ status }: { status: Status }) {
  const tone = status === 'Playing' || status === 'Online' || status === 'Synced' ? 'positive' : status === 'Offline' || status === 'On Hold' ? 'neutral' : status === 'Syncing' ? 'info' : 'muted';
  return <span className={`status-badge status-badge-${tone}`}><i />{status}</span>;
}

export function LoadingState({ label = 'Loading GameTracker…' }: { label?: string }) {
  return <div className="ui-loading" role="status" aria-live="polite"><LoaderCircle className="ui-loading-icon" size={22} /><div><b>{label}</b><span>Getting the latest data ready.</span></div></div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="ui-error" role="alert"><div className="ui-state-icon error"><AlertCircle size={20} /></div><div className="ui-state-copy"><b>Something went wrong</b><span>{message}</span>{onRetry && <button type="button" className="secondary ui-retry" onClick={onRetry}>Retry</button>}</div></div>;
}

export function InfoState({ message }: { message: string }) {
  return <div className="ui-info"><Info size={18} /><span>{message}</span></div>;
}

export function SuccessState({ message }: { message: string }) {
  return <div className="ui-success"><CheckCircle2 size={18} /><span>{message}</span></div>;
}
