import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, refreshSession, setSessionLostHandler, signIn as apiSignIn, signOut as apiSignOut } from '../services/api';
import { authApi } from '../services/endpoints';
import { getRefreshToken } from '../storage/secure';
import { resetAnnounced } from '../notifications/local';
import { clearDownloadedFiles } from '../utils/files';
import { capabilitiesFor, type Capabilities } from './permissions';
import { reportLoginLocation } from './loginLocation';
import type { User } from '../types';

type Status = 'restoring' | 'unreachable' | 'signedOut' | 'signedIn';

interface AuthValue {
  status: Status;
  user: User | null;
  caps: Capabilities | null;
  /** Shown once on the sign-in screen after the server ends a session. */
  notice: string | null;
  signIn: (identifier: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  retryRestore: () => void;
  reloadUser: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

// Nothing belonging to one account may be left for the next person who signs
// in on this phone: cached API data, downloaded documents, generated payslips.
function purgeLocalData(queryClient: { clear: () => void }) {
  queryClient.clear();
  clearDownloadedFiles();
  resetAnnounced();
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('restoring');
  const [user, setUser] = useState<User | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Works out what the stored session resolves to, without touching state.
  const resolveSession = useCallback(async (): Promise<{ status: Status; user: User | null; notice: string | null }> => {
    if (!(await getRefreshToken())) return { status: 'signedOut', user: null, notice: null };
    try {
      return { status: 'signedIn', user: await refreshSession(), notice: null };
    } catch (err) {
      // Only a server refusal ends the stored session. Being offline, or the
      // API still waking, keeps it so the user is not forced to sign in again.
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        await apiSignOut();
        purgeLocalData(queryClient);
        return {
          status: 'signedOut',
          user: null,
          notice: err.code === 'ACCOUNT_DISABLED' ? err.message : 'Your session expired. Please sign in again.',
        };
      }
      return { status: 'unreachable', user: null, notice: null };
    }
  }, [queryClient]);

  const restore = useCallback(() => {
    void resolveSession().then((result) => {
      setUser(result.user);
      if (result.notice) setNotice(result.notice);
      setStatus(result.status);
    });
  }, [resolveSession]);

  useEffect(() => {
    restore();
  }, [restore]);

  useEffect(() => {
    setSessionLostHandler((error) => {
      purgeLocalData(queryClient);
      setUser(null);
      setNotice(error.message || 'Your session ended. Please sign in again.');
      setStatus('signedOut');
    });
    return () => setSessionLostHandler(null);
  }, [queryClient]);

  const signIn = useCallback(async (identifier: string, password: string) => {
    const signedIn = await apiSignIn(identifier, password);
    purgeLocalData(queryClient);
    setNotice(null);
    setUser(signedIn);
    setStatus('signedIn');
    // Signed in already; where from is recorded alongside and never awaited.
    // (A temporary-password account can reach nothing but the password form.)
    if (!signedIn.mustChangePassword) void reportLoginLocation();
  }, [queryClient]);

  const signOut = useCallback(async () => {
    await apiSignOut();
    purgeLocalData(queryClient);
    setUser(null);
    setStatus('signedOut');
  }, [queryClient]);

  const reloadUser = useCallback(async () => {
    const { user: fresh } = await authApi.me();
    setUser(fresh);
  }, []);

  const value = useMemo<AuthValue>(() => ({
    status,
    user,
    caps: user ? capabilitiesFor(user) : null,
    notice,
    signIn,
    signOut,
    retryRestore: () => { setStatus('restoring'); restore(); },
    reloadUser,
  }), [status, user, notice, signIn, signOut, restore, reloadUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** For screens that only render while signed in. */
export function useSession() {
  const { user, caps, ...rest } = useAuth();
  if (!user || !caps) throw new Error('useSession used while signed out');
  return { user, caps, ...rest };
}
