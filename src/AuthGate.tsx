import { useEffect, useState } from 'react';
import { auth } from './local-client';
import { ArrowRight, Download, Gamepad2, KeyRound, MonitorDown, ShieldCheck, Sparkles, X } from 'lucide-react';

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<Awaited<ReturnType<typeof auth.getUser>>>(null);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [registering, setRegistering] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [forgotPasswordMode, setForgotPasswordMode] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState('');
  const [passwordResetToken, setPasswordResetToken] = useState(() => typeof window === 'undefined'
    ? ''
    : new URLSearchParams(window.location.hash.slice(1)).get('reset-password') || '');
  const [passwordResetComplete, setPasswordResetComplete] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  useEffect(() => {
    let cancelled = false;
    auth.getUser().then(current => {
      if (!cancelled) {
        setUser(current);
        setLoading(false);
      }
    }).catch(error => {
      if (!cancelled) {
        setErrorMessage(error instanceof Error ? error.message : 'Unable to check your account.');
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!authOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAuthOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [authOpen]);

  const openAuth = (createAccount = false) => {
    setRegistering(createAccount);
    setErrorMessage('');
    setPassword('');
    setAuthOpen(true);
  };

  const signIn = async () => {
    setSigningIn(true);
    setErrorMessage('');
    setRecoveryMessage('');
    try {
      if (forgotPasswordMode) {
        const result = await auth.requestPasswordReset(email);
        setRecoveryMessage(result.message);
        return;
      }
      const result = registering
        ? await auth.register(name, email, password)
        : await auth.signIn(email, password);
      setUser(result.user);
    } catch (error) {
      const value = error as { code?: string; message?: string };
      setErrorMessage(value.message || (registering ? 'Registration failed. Please try again.' : 'Sign-in failed. Please try again.'));
    } finally {
      setSigningIn(false);
    }
  };

  const submitPasswordReset = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage('');
    if (newPassword.length < 8 || newPassword.length > 128) {
      setErrorMessage('Password must be between 8 and 128 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMessage('The passwords do not match.');
      return;
    }
    setSigningIn(true);
    try {
      await auth.resetPassword(passwordResetToken, newPassword);
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
      setPasswordResetToken('');
      setPasswordResetComplete(true);
      setUser(null);
    } catch (error) {
      const value = error as { message?: string };
      setErrorMessage(value.message || 'Unable to reset your password. Request a new link and try again.');
    } finally {
      setSigningIn(false);
    }
  };

  const returnToSignIn = () => {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    setPasswordResetToken('');
    setPasswordResetComplete(false);
    setPassword('');
    setForgotPasswordMode(false);
    setAuthOpen(true);
  };

  if (passwordResetToken || passwordResetComplete) {
    return (
      <div className="landing-reset-page">
        <section className="landing-auth-dialog landing-reset-dialog" aria-labelledby="password-reset-title">
          <span className="landing-auth-eyebrow"><span className="landing-auth-mark"><KeyRound size={15} /></span> GAMETRACKER ACCOUNT SECURITY</span>
          {passwordResetComplete ? (
            <>
              <h1 id="password-reset-title">Password updated</h1>
              <p>Your password has been changed and all active sessions have been signed out. Sign in again with your new password.</p>
              <button className="landing-auth-submit" type="button" onClick={returnToSignIn}>Return to sign in <ArrowRight size={16} /></button>
            </>
          ) : (
            <>
              <h1 id="password-reset-title">Set a new password</h1>
              <p>Choose a password you have not used before. This one-time link expires after 30 minutes.</p>
              <form className="landing-auth-form" onSubmit={event => void submitPasswordReset(event)}>
                <label className="landing-auth-field"><span>New password</span><input className="landing-auth-input" type="password" autoComplete="new-password" minLength={8} maxLength={128} value={newPassword} onChange={event => setNewPassword(event.target.value)} placeholder="At least 8 characters" required disabled={signingIn} /></label>
                <label className="landing-auth-field"><span>Confirm new password</span><input className="landing-auth-input" type="password" autoComplete="new-password" minLength={8} maxLength={128} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} placeholder="Enter it again" required disabled={signingIn} /></label>
                {errorMessage && <div className="landing-error">{errorMessage}</div>}
                <button className="landing-auth-submit" type="submit" disabled={signingIn}>{signingIn ? 'Updating password…' : 'Update password'} <ArrowRight size={16} /></button>
              </form>
              <div className="landing-auth-assurance"><ShieldCheck size={14} /><span>If you did not request this, secure your email account first.</span></div>
              <button className="landing-auth-switch" type="button" onClick={() => {
                window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
                setPasswordResetToken('');
                setUser(null);
                setForgotPasswordMode(true);
                setAuthOpen(true);
              }}>Request another reset link</button>
            </>
          )}
        </section>
      </div>
    );
  }

  if (loading) return <div className="auth-loading">Checking your GameTracker account…</div>;
  if (user) return <>{children}</>;

  return (
    <div className="landing-page">
      <header className="landing-nav">
        <div className="landing-brand">
          <span className="landing-mark"><img src="./resources/app-icon.png" alt="GameTracker app icon" /></span>
          <div><strong>GameTracker</strong><small>Gaming activity, under control.</small></div>
        </div>
        <button className="landing-signin" onClick={() => openAuth(false)}>
          Sign in <ArrowRight size={16} />
        </button>
      </header>

      <main>
        <section className="landing-hero">
          <div className="landing-copy">
            <div className="landing-kicker"><span className="landing-pulse" /> PRIVATE · ACCOUNT-BASED TRACKING</div>
            <h1>Track your games.<br /><em>Control your setup.</em></h1>
            <p>GameTracker brings your gaming library, sessions, backlog, and paired Windows PC into one clean dashboard. Sign in once, then control your own PC from any device.</p>
            <div className="landing-actions">
              <button className="landing-primary" onClick={() => openAuth(true)}>Get started <ArrowRight size={17} /></button>
              <a className="landing-signin" href="https://github.com/MarkSilla/GameTracker.exe/releases/latest/download/GameTracker-Setup-1.7.1.exe"><Download size={16} /> Download for Windows</a>
              <span className="landing-note"><ShieldCheck size={15} /> Your account owns its paired devices and data.</span>
            </div>
          </div>
          <div className="landing-preview">
            <div className="preview-top"><span><i /> GAME TRACKER</span><small>YOUR DASHBOARD</small></div>
            <div className="preview-live"><div className="preview-icon"><Gamepad2 size={21} /></div><div><b>Live Monitor</b><span>Windows PC · Connected</span></div><strong>01:24:18</strong></div>
            <div className="preview-grid"><div><span>Playtime</span><b>42.6h</b></div><div><span>Games</span><b>18</b></div><div><span>Backlog</span><b>7</b></div></div>
            <div className="preview-row"><span><MonitorDown size={15} /> Paired Windows PC</span><b>● Online</b></div>
            <div className="preview-bar"><i /></div>
            <div className="preview-caption">Realtime game detection · End Game remotely · Session history</div>
          </div>
        </section>

        <section className="landing-features">
          <div className="feature-card"><MonitorDown size={20} /><h3>Remote control</h3><p>Pair your Windows Agent once, then monitor and end active games from the same dashboard on your phone or another PC.</p></div>
          <div className="feature-card"><Sparkles size={20} /><h3>Automatic tracking</h3><p>Configured Windows games are detected by the desktop agent and sessions update as games start and stop.</p></div>
          <div className="feature-card"><ShieldCheck size={20} /><h3>Private by account</h3><p>Sign in to access your dashboard. Your paired PCs, games, sessions, and controls stay scoped to your account.</p></div>
        </section>

        <section className="landing-bottom">
          <span>ONE DASHBOARD · ANY DEVICE</span>
          <h2>From your PC to your phone,<br />your game activity stays in sync.</h2>
          <button onClick={() => openAuth(false)}>Sign in to GameTracker <ArrowRight size={16} /></button>
        </section>
      </main>
      <footer className="landing-footer"><span>© 2026 GameTracker</span><span>Local-first · Account-secured · Responsive</span></footer>
      {authOpen && (
        <div className="landing-auth-backdrop" onClick={event => { if (event.target === event.currentTarget) setAuthOpen(false); }}>
          <section className="landing-auth-dialog" role="dialog" aria-modal="true" aria-labelledby="landing-auth-title">
            <div className="landing-auth-heading">
              <div>
                <span className="landing-auth-eyebrow"><span className="landing-auth-mark"><Gamepad2 size={15} /></span> GAMETRACKER ACCOUNT</span>
                <h2 id="landing-auth-title">{forgotPasswordMode ? 'Reset your password' : registering ? 'Create your account' : 'Welcome back'}</h2>
                <p>{forgotPasswordMode ? 'We will email a one-time reset link if an account matches.' : registering ? 'Create an account to start tracking your games.' : 'Sign in to open your GameTracker dashboard.'}</p>
              </div>
              <button className="landing-auth-close" type="button" onClick={() => setAuthOpen(false)} aria-label="Close sign-in form"><X size={18} /></button>
            </div>
            <form className="landing-auth-form" onSubmit={event => { event.preventDefault(); void signIn(); }}>
              {registering && !forgotPasswordMode && <label className="landing-auth-field"><span>Your name</span><input className="landing-auth-input" value={name} onChange={event => setName(event.target.value)} placeholder="How should we address you?" autoComplete="name" maxLength={100} required disabled={signingIn} /></label>}
              <label className="landing-auth-field"><span>Email address</span><input className="landing-auth-input" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" type="email" autoComplete="email" maxLength={254} required disabled={signingIn} /></label>
              {!registering && !forgotPasswordMode && <label className="landing-auth-field"><span>Password</span><input className="landing-auth-input" value={password} onChange={event => setPassword(event.target.value)} placeholder="Enter your password" type="password" autoComplete="current-password" maxLength={128} required disabled={signingIn} /></label>}
              {registering && !forgotPasswordMode && <label className="landing-auth-field"><span>Password</span><input className="landing-auth-input" value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 8 characters" type="password" autoComplete="new-password" minLength={8} maxLength={128} required disabled={signingIn} /></label>}
              {!registering && !forgotPasswordMode && <button className="landing-auth-forgot" type="button" onClick={() => { setForgotPasswordMode(true); setErrorMessage(''); setRecoveryMessage(''); }}>Forgot password?</button>}
              {errorMessage && <div className="landing-error">{errorMessage}</div>}
              {recoveryMessage && <div className="landing-auth-success">{recoveryMessage}</div>}
              <button className="landing-auth-submit" type="submit" disabled={signingIn}>{signingIn ? 'Please wait…' : forgotPasswordMode ? 'Send reset link' : registering ? 'Create account' : 'Sign in'} <ArrowRight size={16} /></button>
            </form>
            <div className="landing-auth-assurance"><ShieldCheck size={14} /><span>{registering ? 'No invite code or external verification needed.' : 'Your account and paired PC stay private.'}</span></div>
            <button className="landing-auth-switch" type="button" disabled={signingIn} onClick={() => {
              if (forgotPasswordMode) {
                setForgotPasswordMode(false);
                setRecoveryMessage('');
              } else {
                setRegistering(current => !current);
                setPassword('');
              }
              setErrorMessage('');
            }}>
              {forgotPasswordMode ? 'Back to sign in' : registering ? 'Already have an account? Sign in' : 'New here? Create an account'}
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
