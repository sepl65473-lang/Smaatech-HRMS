import { useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import { DEFAULT_LOGIN_PROFILES } from '../lib/permissions';
import ForgotPasswordModal from './ForgotPasswordModal';

export default function LoginScreen() {
  const {
    login, loginWithMobile, finishLogin, forgotPassword: requestPasswordResetOtp,
    resetPassword: resetPasswordOnServer, settings, toast,
  } = useHRMS();
  const profiles = settings.loginProfiles?.length ? settings.loginProfiles : DEFAULT_LOGIN_PROFILES;
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  // Two ways into the SAME account: the workspace email, or the mobile number
  // an admin stored on the employee record. Same password either way.
  const [byMobile, setByMobile] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [forgotOpen, setForgotOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Password sign-in is the whole flow: the server either rejects the
  // credentials or issues the session in the same response. (There used to be
  // an emailed 2FA code step here; it has been removed.)
  const submit = async () => {
    try {
      const { accessToken, user } = byMobile
        ? await loginWithMobile(mobile.trim(), password)
        : await login(email.trim(), password);
      setError('');
      await finishLogin(accessToken, user);
    } catch (err) {
      setError(err.message || (byMobile ? 'Invalid mobile number or password.' : 'Invalid email or password.'));
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
              Enter your workspace {byMobile ? 'mobile number' : 'email'} and password.<br />
              This session is stored locally in this browser.
            </p>

            {/* Identifier field — workspace email, or the registered mobile number */}
            <div className="login-field">
              <label className="login-label">{byMobile ? 'Mobile number' : 'Email'}</label>
              <div className="login-input-wrap">
                <svg className="login-input-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                  <circle cx="12" cy="7" r="4"/>
                </svg>
                {byMobile ? (
                  <input
                    className="login-input"
                    type="tel"
                    value={mobile}
                    onChange={(e) => { setMobile(e.target.value); setError(''); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                    placeholder="+91 98765 43210"
                    autoFocus
                  />
                ) : (
                <input
                  className="login-input"
                  type="email"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                  placeholder="you@smaatech.co"
                  autoFocus
                />
                )}
              </div>
              <button
                type="button"
                className="login-forgot-btn"
                style={{ marginTop: 8 }}
                onClick={() => { setByMobile((v) => !v); setError(''); }}
              >
                {byMobile ? 'Use email instead' : 'Use mobile number instead'}
              </button>
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

          </div>
      </div>

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
