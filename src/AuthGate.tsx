import { useEffect, useState } from 'react';
import { auth } from './local-client';
import { ArrowRight, Download, Gamepad2, MonitorDown, ShieldCheck, Sparkles, X } from 'lucide-react';

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<Awaited<ReturnType<typeof auth.getUser>>>(null);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [registering, setRegistering] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [middleName, setMiddleName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [forgotPasswordMode, setForgotPasswordMode] = useState(false);
  const [emailVerificationMode, setEmailVerificationMode] = useState(false);
  const [recoveryCodeMode, setRecoveryCodeMode] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState('');

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
    setForgotPasswordMode(false);
    setEmailVerificationMode(false);
    setRecoveryCodeMode(false);
    setErrorMessage('');
    setRecoveryMessage('');
    setPassword('');
    setVerificationCode('');
    setAuthOpen(true);
  };

  const signIn = async () => {
    setSigningIn(true);
    setErrorMessage('');
    setRecoveryMessage('');
    try {
      if (registering) {
        if (emailVerificationMode) {
          const result = await auth.verifyEmail(email, verificationCode);
          setUser(result.user);
          return;
        }
        const result = await auth.register(firstName, middleName, lastName, email, password);
        setEmailVerificationMode(true);
        setVerificationCode('');
        setPassword('');
        setRecoveryMessage(result.message);
        return;
      }
      if (forgotPasswordMode) {
        if (!recoveryCodeMode) {
          const result = await auth.requestPasswordReset(email);
          setRecoveryCodeMode(true);
          setVerificationCode('');
          setRecoveryMessage(result.message);
          return;
        }
        if (password.length < 8 || password.length > 128) {
          setErrorMessage('Password must be between 8 and 128 characters.');
          return;
        }
        if (password !== confirmPassword) {
          setErrorMessage('The passwords do not match.');
          return;
        }
        await auth.resetPassword(email, verificationCode, password);
        setForgotPasswordMode(false);
        setRecoveryCodeMode(false);
        setVerificationCode('');
        setPassword('');
        setConfirmPassword('');
        setRecoveryMessage('Your password has been changed. Sign in with your new password. All active sessions were signed out.');
        return;
      }
      const result = await auth.signIn(email, password);
      setUser(result.user);
    } catch (error) {
      const value = error as { code?: string; message?: string };
      setErrorMessage(value.message || (registering ? 'Sign-up failed. Please try again.' : forgotPasswordMode ? 'Password recovery failed. Please try again.' : 'Sign-in failed. Please try again.'));
    } finally {
      setSigningIn(false);
    }
  };

  const resendCode = async () => {
    setSigningIn(true);
    setErrorMessage('');
    try {
      const result = registering
        ? await auth.register(firstName, middleName, lastName, email, password)
        : await auth.requestPasswordReset(email);
      setVerificationCode('');
      setRecoveryMessage(registering ? result.message : 'If an account exists for that email, a new verification code has been sent.');
    } catch (error) {
      const value = error as { message?: string };
      setErrorMessage(value.message || 'Unable to send another code. Please try again.');
    } finally {
      setSigningIn(false);
    }
  };

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
                <h2 id="landing-auth-title">{forgotPasswordMode ? 'Reset your password' : emailVerificationMode ? 'Verify your email' : registering ? 'Create your account' : 'Welcome back'}</h2>
                <p>{emailVerificationMode ? 'Enter the 6-digit code we sent to your email. It expires in 10 minutes.' : forgotPasswordMode ? recoveryCodeMode ? 'Enter the 6-digit code from your email and choose a new password.' : 'We will email a one-time verification code if an account matches.' : registering ? 'Create an account to start tracking your games.' : 'Sign in to open your GameTracker dashboard.'}</p>
              </div>
              <button className="landing-auth-close" type="button" onClick={() => setAuthOpen(false)} aria-label="Close sign-in form"><X size={18} /></button>
            </div>
            <form className="landing-auth-form" onSubmit={event => { event.preventDefault(); void signIn(); }}>
              {registering && !emailVerificationMode && <label className="landing-auth-field"><span>First name</span><input className="landing-auth-input" value={firstName} onChange={event => setFirstName(event.target.value)} placeholder="First name" autoComplete="given-name" maxLength={100} required disabled={signingIn} /></label>}
              {registering && !emailVerificationMode && <label className="landing-auth-field"><span>Middle name <small>(optional)</small></span><input className="landing-auth-input" value={middleName} onChange={event => setMiddleName(event.target.value)} placeholder="Middle name (optional)" autoComplete="additional-name" maxLength={100} disabled={signingIn} /></label>}
              {registering && !emailVerificationMode && <label className="landing-auth-field"><span>Last name</span><input className="landing-auth-input" value={lastName} onChange={event => setLastName(event.target.value)} placeholder="Last name" autoComplete="family-name" maxLength={100} required disabled={signingIn} /></label>}
              <label className="landing-auth-field"><span>Email address</span><input className="landing-auth-input" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" type="email" autoComplete="email" maxLength={254} required disabled={signingIn || emailVerificationMode || recoveryCodeMode} /></label>
              {!forgotPasswordMode && !emailVerificationMode && <label className="landing-auth-field"><span>Password</span><input className="landing-auth-input" value={password} onChange={event => setPassword(event.target.value)} placeholder={registering ? 'At least 8 characters' : 'Enter your password'} type="password" autoComplete={registering ? 'new-password' : 'current-password'} minLength={registering ? 8 : undefined} maxLength={128} required disabled={signingIn} /></label>}
              {(emailVerificationMode || recoveryCodeMode) && <label className="landing-auth-field"><span>6-digit email code</span><input className="landing-auth-input landing-auth-code" value={verificationCode} onChange={event => setVerificationCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" required disabled={signingIn} /></label>}
              {forgotPasswordMode && recoveryCodeMode && <>
                <label className="landing-auth-field"><span>New password</span><input className="landing-auth-input" value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 8 characters" type="password" autoComplete="new-password" minLength={8} maxLength={128} required disabled={signingIn} /></label>
                <label className="landing-auth-field"><span>Confirm new password</span><input className="landing-auth-input" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} placeholder="Enter it again" type="password" autoComplete="new-password" minLength={8} maxLength={128} required disabled={signingIn} /></label>
              </>}
              {!registering && !forgotPasswordMode && <button className="landing-auth-forgot" type="button" onClick={() => { setForgotPasswordMode(true); setRecoveryCodeMode(false); setErrorMessage(''); setRecoveryMessage(''); setVerificationCode(''); }}>Forgot password?</button>}
              {errorMessage && <div className="landing-error">{errorMessage}</div>}
              {recoveryMessage && <div className="landing-auth-success">{recoveryMessage}</div>}
              <button className="landing-auth-submit" type="submit" disabled={signingIn}>{signingIn ? 'Please wait…' : emailVerificationMode ? 'Verify email & create account' : forgotPasswordMode ? recoveryCodeMode ? 'Reset password' : 'Send verification code' : registering ? 'Send verification code' : 'Sign in'} <ArrowRight size={16} /></button>
            </form>
            {(emailVerificationMode || recoveryCodeMode) && <button className="landing-auth-resend" type="button" disabled={signingIn} onClick={() => void resendCode()}>Send a new code</button>}
            <div className="landing-auth-assurance"><ShieldCheck size={14} /><span>{registering ? 'Email verification helps protect your account.' : 'Your account and paired PC stay private.'}</span></div>
            <button className="landing-auth-switch" type="button" disabled={signingIn} onClick={() => {
              if (emailVerificationMode) {
                setEmailVerificationMode(false);
                setVerificationCode('');
                setRecoveryMessage('');
              } else if (forgotPasswordMode && recoveryCodeMode) {
                setRecoveryCodeMode(false);
                setVerificationCode('');
                setPassword('');
                setConfirmPassword('');
                setRecoveryMessage('');
              } else if (forgotPasswordMode) {
                setForgotPasswordMode(false);
                setRecoveryMessage('');
              } else {
                setRegistering(current => !current);
                setPassword('');
                setFirstName('');
                setMiddleName('');
                setLastName('');
              }
              setErrorMessage('');
            }}>
              {emailVerificationMode ? 'Back to sign-up details' : forgotPasswordMode ? recoveryCodeMode ? 'Use a different email' : 'Back to sign in' : registering ? 'Already have an account? Sign in' : 'New here? Create an account'}
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
