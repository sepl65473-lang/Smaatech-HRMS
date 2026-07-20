import { useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import { DEFAULT_LOGIN_PROFILES } from '../lib/permissions';
import FaceLogin from './FaceLogin';
import ForgotPasswordModal from './ForgotPasswordModal';

export default function LoginScreen() {
  const {
    login, loginWithFace, verifyTwoFactor, finishLogin, forgotPassword: requestPasswordResetOtp,
    resetPassword: resetPasswordOnServer, settings, toast,
  } = useHRMS();
  const profiles = settings.loginProfiles?.length ? settings.loginProfiles : DEFAULT_LOGIN_PROFILES;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [faceOpen, setFaceOpen] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Two-Factor Authentication state. The server decides whether 2FA is
  // required (per-company Settings.twoFactor) and, if so, emails a real
  // code and withholds any session until /verify-2fa confirms it — no
  // token exists client-side until that succeeds, unlike the old flow.
  const [pendingEmail, setPendingEmail] = useState('');
  const [authMethod, setAuthMethod] = useState('password'); // 'password' | 'face', for Resend
  const [otpMode, setOtpMode] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [otpError, setOtpError] = useState('');

  const proceedAfterAuth = async (result) => {
    if (result.requiresTwoFactor) {
      setPendingEmail(result.email);
      setOtpCode('');
      setOtpError('');
      setOtpMode(true);
      toast('info', `We've emailed a 6-digit verification code to <strong>${result.email}</strong>.`);
    } else {
      await finishLogin(result.accessToken, result.user);
    }
  };

  const submit = async () => {
    try {
      setAuthMethod('password');
      const result = await login(email.trim(), password);
      setError('');
      await proceedAfterAuth(result);
    } catch (err) {
      setError(err.message || 'Invalid email or password.');
    }
  };

  const verifyOtp = async () => {
    try {
      const { accessToken, user } = await verifyTwoFactor(pendingEmail, otpCode.trim());
      setOtpMode(false);
      setPendingEmail('');
      setOtpCode('');
      await finishLogin(accessToken, user);
    } catch (err) {
      setOtpError(err.message || 'Incorrect or expired code.');
    }
  };

  const resendCode = async () => {
    try {
      const result = authMethod === 'face' ? await loginWithFace(pendingEmail) : await login(email.trim(), password);
      if (result.requiresTwoFactor) {
        setPendingEmail(result.email);
        setOtpCode('');
        setOtpError('');
        toast('info', `New code sent to <strong>${result.email}</strong>.`);
      } else {
        // 2FA got turned off server-side mid-flow — just finish signing in.
        setOtpMode(false);
        await finishLogin(result.accessToken, result.user);
      }
    } catch (err) {
      setOtpError(err.message || 'Could not resend the code.');
    }
  };

  return (
    <div className="login-shell">
      {/* Left side - Blue wave background with branding */}
      <div className="login-left">
        {/* SVG Wave Background */}
        <svg className="login-wave-bg" viewBox="0 0 800 900" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="waveGrad1" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#e8edf5" />
              <stop offset="100%" stopColor="#c5d3e8" />
            </linearGradient>
            <linearGradient id="waveGrad2" x1="0%" y1="20%" x2="80%" y2="100%">
              <stop offset="0%" stopColor="#a8bdd9" />
              <stop offset="100%" stopColor="#4a6fa5" />
            </linearGradient>
            <linearGradient id="waveGrad3" x1="0%" y1="30%" x2="100%" y2="80%">
              <stop offset="0%" stopColor="#4a6fa5" />
              <stop offset="100%" stopColor="#1a3a6b" />
            </linearGradient>
            <linearGradient id="waveGrad4" x1="0%" y1="40%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#2c5490" />
              <stop offset="100%" stopColor="#0f2847" />
            </linearGradient>
          </defs>
          {/* Background fill */}
          <rect width="800" height="900" fill="#edf1f7" />
          {/* Wave layer 1 - lightest */}
          <path d="M-50,400 C100,350 200,500 350,420 C500,340 600,480 850,380 L850,900 L-50,900 Z" fill="url(#waveGrad1)" opacity="0.6">
            <animate attributeName="d" dur="8s" repeatCount="indefinite" values="
              M-50,400 C100,350 200,500 350,420 C500,340 600,480 850,380 L850,900 L-50,900 Z;
              M-50,420 C100,380 200,470 350,440 C500,370 600,450 850,400 L850,900 L-50,900 Z;
              M-50,400 C100,350 200,500 350,420 C500,340 600,480 850,380 L850,900 L-50,900 Z
            " />
          </path>
          {/* Wave layer 2 */}
          <path d="M-50,480 C120,430 250,560 400,490 C550,420 650,540 850,460 L850,900 L-50,900 Z" fill="url(#waveGrad2)" opacity="0.7">
            <animate attributeName="d" dur="10s" repeatCount="indefinite" values="
              M-50,480 C120,430 250,560 400,490 C550,420 650,540 850,460 L850,900 L-50,900 Z;
              M-50,500 C120,460 250,530 400,510 C550,450 650,510 850,480 L850,900 L-50,900 Z;
              M-50,480 C120,430 250,560 400,490 C550,420 650,540 850,460 L850,900 L-50,900 Z
            " />
          </path>
          {/* Wave layer 3 */}
          <path d="M-50,560 C150,510 280,640 430,570 C580,500 680,610 850,540 L850,900 L-50,900 Z" fill="url(#waveGrad3)" opacity="0.8">
            <animate attributeName="d" dur="12s" repeatCount="indefinite" values="
              M-50,560 C150,510 280,640 430,570 C580,500 680,610 850,540 L850,900 L-50,900 Z;
              M-50,580 C150,540 280,610 430,590 C580,530 680,580 850,560 L850,900 L-50,900 Z;
              M-50,560 C150,510 280,640 430,570 C580,500 680,610 850,540 L850,900 L-50,900 Z
            " />
          </path>
          {/* Wave layer 4 - darkest */}
          <path d="M-50,650 C130,600 300,720 450,660 C600,600 720,700 850,630 L850,900 L-50,900 Z" fill="url(#waveGrad4)" opacity="0.9">
            <animate attributeName="d" dur="14s" repeatCount="indefinite" values="
              M-50,650 C130,600 300,720 450,660 C600,600 720,700 850,630 L850,900 L-50,900 Z;
              M-50,670 C130,630 300,690 450,680 C600,630 720,670 850,650 L850,900 L-50,900 Z;
              M-50,650 C130,600 300,720 450,660 C600,600 720,700 850,630 L850,900 L-50,900 Z
            " />
          </path>
        </svg>
        
        {/* Logo and Branding */}
        <div className="login-branding">
          <div className="login-logo-wrap">
            <img src="/logo.jpg" alt={settings.orgName || 'SEPL'} className="login-logo-img" />
          </div>
          <div className="login-brand-text">
            <h2 className="login-brand-name">{settings.orgName || 'SEPL'} HRMS</h2>
            <div className="login-brand-divider">
              <span className="login-brand-line"></span>
              <span className="login-brand-subtitle">Human Resource Management System</span>
              <span className="login-brand-line"></span>
            </div>
          </div>
        </div>
      </div>

      {/* Right side - Login form card */}
      <div className="login-right">
        {otpMode ? (
          <div className="login-card">
            {/* 2FA Shield badge */}
            <div className="login-secure-badge" style={{ backgroundColor: 'rgba(59,125,221,0.1)', color: '#3b7ddd' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
              <span>Security checkpoint</span>
            </div>

            {/* Title */}
            <h1 className="login-title">Two-Factor Authentication</h1>
            <p className="login-description">
              We've emailed a 6-digit verification code to {pendingEmail || 'your inbox'}.<br />
              Enter the code below to complete sign in.
            </p>

            {/* OTP Input field */}
            <div className="login-field">
              <label className="login-label">Verification Code</label>
              <div className="login-input-wrap">
                <input
                  className="login-input mono"
                  type="text"
                  maxLength="6"
                  value={otpCode}
                  onChange={(e) => { setOtpCode(e.target.value.replace(/[^0-9]/g, '')); setOtpError(''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') verifyOtp(); }}
                  placeholder="000000"
                  style={{ textAlign: 'center', letterSpacing: '4px', fontSize: '20px' }}
                  autoFocus
                />
              </div>
              {otpError && <span className="login-error" style={{ textAlign: 'center', display: 'block', marginTop: 8 }}>{otpError}</span>}
            </div>

            {/* Resend and back links */}
            <div className="login-forgot-row" style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginTop: 8 }}>
              <button
                type="button"
                className="login-forgot-btn"
                onClick={resendCode}
              >
                Resend Code
              </button>
              <button
                type="button"
                className="login-forgot-btn"
                onClick={() => { setOtpMode(false); setPendingEmail(''); setOtpCode(''); setOtpError(''); }}
              >
                Back to Login
              </button>
            </div>

            {/* Verify button */}
            <button type="button" className="login-submit-btn" onClick={verifyOtp} style={{ marginTop: 24 }}>
              Verify & Sign in
            </button>
          </div>
        ) : (
          <div className="login-card">
            {/* Secure access badge */}
            <div className="login-secure-badge">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                <polyline points="9 12 11 14 15 10"/>
              </svg>
              <span>Secure access</span>
            </div>

            {/* Title */}
            <h1 className="login-title">Sign in to HRMS</h1>
            <p className="login-description">
              Enter your workspace email and password.<br />
              This session is stored locally in this browser.
            </p>

            {/* Email field */}
            <div className="login-field">
              <label className="login-label">Email</label>
              <div className="login-input-wrap">
                <svg className="login-input-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                  <circle cx="12" cy="7" r="4"/>
                </svg>
                <input
                  className="login-input"
                  type="email"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                  placeholder="you@smaatech.co"
                  autoFocus
                />
              </div>
            </div>

            {/* Password field */}
            <div className="login-field">
              <label className="login-label">Password</label>
              <div className="login-input-wrap">
                <svg className="login-input-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
                <input
                  className="login-input"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  className="login-eye-btn"
                  onClick={() => setShowPassword(!showPassword)}
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                      <line x1="1" y1="1" x2="23" y2="23"/>
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                  )}
                </button>
              </div>
              {error && <span className="login-error">{error}</span>}
            </div>

            {/* Forgot password */}
            <div className="login-forgot-row">
              <button
                type="button"
                className="login-forgot-btn"
                onClick={() => setForgotOpen(true)}
              >
                Forgot password?
              </button>
            </div>

            {/* Sign in button */}
            <button className="login-submit-btn" onClick={submit}>
              Sign in
            </button>

            {/* Divider */}
            <div className="login-divider">
              <span className="login-divider-line"></span>
              <span className="login-divider-text">or</span>
              <span className="login-divider-line"></span>
            </div>

            {/* Sign in with face */}
            <button className="login-face-btn" onClick={() => setFaceOpen(true)}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="3"/>
                <circle cx="9" cy="10" r="1.2" fill="currentColor" stroke="none"/>
                <circle cx="15" cy="10" r="1.2" fill="currentColor" stroke="none"/>
                <path d="M9 15c.83.67 2 1 3 1s2.17-.33 3-1"/>
              </svg>
              <span>Sign in with face</span>
            </button>
          </div>
        )}
      </div>

      <FaceLogin
        open={faceOpen}
        profiles={profiles}
        onClose={() => setFaceOpen(false)}
        onMatch={async (profile) => {
          setFaceOpen(false);
          try {
            setAuthMethod('face');
            await proceedAfterAuth(await loginWithFace(profile.email));
          } catch (err) {
            toast('error', err.message || 'Face sign-in failed.');
          }
        }}
      />

      <ForgotPasswordModal
        open={forgotOpen}
        onClose={() => setForgotOpen(false)}
        onRequestOtp={requestPasswordResetOtp}
        onReset={async (matchedEmail, otp, newPassword) => {
          await resetPasswordOnServer(matchedEmail, otp, newPassword);
          toast('success', 'Password updated — sign in with your new password');
        }}
      />
    </div>
  );
}
