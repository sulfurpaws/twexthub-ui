import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { api, ApiError } from '../services/api';
import { AuthSessionResponse, User } from '../types/api';

interface AuthContextType {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isAdmin: boolean;
  isLoading: boolean;
  latestTermsVersion: number | null;
  /** Whether the registry has published a Terms of Service at all. */
  /** True only when terms are confirmed to exist. */
  hasTerms: boolean;
  /** True once terms availability is known (published or 404). */
  termsResolved: boolean;
  hasAcceptedCurrentTerms: boolean;
  login: (namespace: string, password: string) => Promise<void>;
  signup: (namespace: string, password: string, displayName?: string) => Promise<void>;
  /**
   * Redeems the provider's one-time code and adopts the resulting session.
   * Resolves `false` when the exchange was superseded by a newer sign-in or
   * sign-out, so callers do not treat it as a successful login.
   */
  completeOidcLogin: (code: string) => Promise<boolean>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  acceptCurrentTerms: (version?: number) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function isSameUser(a: User, b: User): boolean {
  return (
    a.namespace === b.namespace &&
    a.displayName === b.displayName &&
    a.role === b.role &&
    a.hasPublished === b.hasPublished &&
    a.createdAt === b.createdAt &&
    a.termsAcceptedVersion === b.termsAcceptedVersion
  );
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(api.getStoredUser());
  const [token, setToken] = useState<string | null>(api.getToken());
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [latestTermsVersion, setLatestTermsVersion] = useState<number | null>(null);
  const [hasTerms, setHasTerms] = useState(false);
  const [termsResolved, setTermsResolved] = useState(false);
  const isCheckingAuthRef = useRef(false);
  // Sign-in and sign-out share one attempt counter. Every start bumps it, so a
  // completion whose attempt has already been outrun is a leftover rather than
  // the newest decision: it must roll the credentials it just persisted back to
  // the session that actually settled. `api.login`/`exchangeOidcCode` persist to
  // localStorage before this context ever sees the response, which is why the
  // rollback has to write the storage back too.
  const authAttemptRef = useRef(0);
  const settledSessionRef = useRef<{ token: string | null; user: User | null }>({
    token,
    user,
  });

  // Check latest terms version from API
  const fetchTermsVersion = useCallback(async () => {
    try {
      const terms = await api.getTerms();
      setLatestTermsVersion(terms.version);
      setHasTerms(true);
      setTermsResolved(true);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        // The registry has never published terms, so there is nothing to
        // accept. Only an explicit 404 licenses that conclusion.
        setLatestTermsVersion(null);
        setHasTerms(false);
        setTermsResolved(true);
      } else {
        // Availability is unknown. Keep the last known state and never let a
        // transient failure stand in for "no terms", which would otherwise
        // silently drop a real acceptance requirement.
        setTermsResolved(false);
      }
    }
  }, []);

  // Tears down the api layer, the local state, and the settled-session record.
  // `bump` marks the call as a new decision, so any sign-in still in flight is
  // outranked and its late response cannot resurrect the session. The automatic
  // cleanup in `verifyAuth` passes false: an invalid token it discards must not
  // cancel the sign-in that is about to replace it.
  const signOut = useCallback(async (bump: boolean) => {
    const attempt = bump ? ++authAttemptRef.current : authAttemptRef.current;
    if (bump) {
      settledSessionRef.current = { token: null, user: null };
    }
    // Remember which settled token this call set out to discard. A sign-in
    // that was already underway can settle during the request without
    // outranking it (it started earlier), so the token change is the signal
    // that the session now belongs to that sign-in.
    const discardedToken = settledSessionRef.current.token;
    try {
      await api.logout();
    } catch {
      // Ignore network errors on logout
    }
    const settled = settledSessionRef.current;
    if (authAttemptRef.current !== attempt || settled.token !== discardedToken) {
      // A sign-in outranks this sign-out; hand the session back to it rather
      // than clobbering the credentials it just adopted.
      api.setToken(settled.token);
      api.setStoredUser(settled.user);
      setUser(settled.user);
      setToken(settled.token);
      return;
    }
    api.setToken(null);
    api.setStoredUser(null);
    settledSessionRef.current = { token: null, user: null };
    setUser(null);
    setToken(null);
  }, []);

  const logout = useCallback(() => signOut(true), [signOut]);

  // Fetch GET /me every so often and log the user out if their token is invalid or missing.
  // Reads the token/user from the api layer (not React state) and bails out of `setUser` when the
  // payload is unchanged, so the callback stays referentially stable and `getMe` is not re-triggered
  // in a loop that would make profile pages re-fetch and re-show skeletons on every render.
  const verifyAuth = useCallback(async () => {
    const currentToken = api.getToken();
    if (!currentToken) {
      if (api.getStoredUser()) {
        await signOut(false);
      }
      return;
    }

    if (isCheckingAuthRef.current) return;
    isCheckingAuthRef.current = true;

    try {
      const freshUser = await api.getMe();
      // The token may have changed (login/logout) while the request was in
      // flight; discard the stale response instead of clobbering the new state.
      if (api.getToken() !== currentToken) return;
      setUser((prev) => (prev && isSameUser(prev, freshUser) ? prev : freshUser));
      setToken(currentToken);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        // 401 Unauthorized, 403 Forbidden, 404 User Not Found indicate invalid or revoked token
        // Only tear the session down if the same token is still current; a
        // login that replaced it while the request was in flight owns the
        // session now and must not be invalidated by this stale response.
        if (
          (err.status === 401 || err.status === 403 || err.status === 404) &&
          api.getToken() === currentToken
        ) {
          await signOut(false);
        }
      }
    } finally {
      isCheckingAuthRef.current = false;
    }
  }, [signOut]);

  const refreshUser = useCallback(async () => {
    await verifyAuth();
  }, [verifyAuth]);

  // Initial auth and terms verification
  useEffect(() => {
    const init = async () => {
      setIsLoading(true);
      await fetchTermsVersion();
      if (api.getToken()) {
        await verifyAuth();
      }
      setIsLoading(false);
    };
    init();
  }, [fetchTermsVersion, verifyAuth]);

  // Periodic auth verification: Check GET /me periodically (every 20 seconds)
  useEffect(() => {
    if (!token) return;

    const intervalId = setInterval(() => {
      verifyAuth();
    }, 20000);

    const handleFocus = () => {
      verifyAuth();
    };

    window.addEventListener('focus', handleFocus);
    window.addEventListener('visibilitychange', handleFocus);

    return () => {
      clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('visibilitychange', handleFocus);
    };
  }, [token, verifyAuth]);

  // Adopts a sign-in only while its attempt is still the newest one. A
  // superseded completion undoes the persistence the api layer already did and
  // restores the session that settled in its place.
  const settleSignIn = (attempt: number, res: AuthSessionResponse): boolean => {
    if (authAttemptRef.current !== attempt) {
      const settled = settledSessionRef.current;
      api.setToken(settled.token);
      api.setStoredUser(settled.user);
      setUser(settled.user);
      setToken(settled.token);
      return false;
    }
    settledSessionRef.current = { token: res.token, user: res.user };
    setUser(res.user);
    setToken(res.token);
    return true;
  };

  const login = async (namespace: string, password: string) => {
    const attempt = ++authAttemptRef.current;
    const res = await api.login({ namespace, password });
    if (settleSignIn(attempt, res)) {
      await fetchTermsVersion();
    }
  };

  const signup = async (namespace: string, password: string, displayName?: string) => {
    const attempt = ++authAttemptRef.current;
    const res = await api.signup({ namespace, password, displayName });
    if (settleSignIn(attempt, res)) {
      await fetchTermsVersion();
    }
  };

  const completeOidcLogin = async (code: string): Promise<boolean> => {
    const attempt = ++authAttemptRef.current;
    const res = await api.exchangeOidcCode(code);
    if (!settleSignIn(attempt, res)) {
      // A newer sign-in or sign-out outranked this exchange; report the
      // cancellation instead of resolving as a successful login.
      return false;
    }
    await fetchTermsVersion();
    return true;
  };

  const acceptCurrentTerms = async (version?: number) => {
    // Callers may pin the version they displayed (e.g. the terms page passes
    // the version it rendered); otherwise fall back to the context's copy.
    let versionToAccept: number;
    if (version !== undefined) {
      versionToAccept = version;
    } else {
      if (latestTermsVersion === null) {
        throw new Error('Terms version could not be loaded. Please try again.');
      }
      versionToAccept = latestTermsVersion;
    }
    await api.acceptTerms(versionToAccept);
    if (user) {
      const updatedUser = { ...user, termsAcceptedVersion: versionToAccept };
      setUser(updatedUser);
      api.setStoredUser(updatedUser);
    }
  };

  // With no published terms there is nothing to accept, so accounts are never
  // blocked on acceptance; the registry's terms gate is open in that state too.
  // Until availability is resolved this stays false, so a failed fetch can
  // never be mistaken for a satisfied requirement.
  const hasAcceptedCurrentTerms =
    (termsResolved && !hasTerms) ||
    Boolean(
      user &&
      latestTermsVersion !== null &&
      user.termsAcceptedVersion !== null &&
      user.termsAcceptedVersion !== undefined &&
      user.termsAcceptedVersion >= latestTermsVersion,
    );

  const isAdmin = Boolean(user && user.role === 'admin');

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isAuthenticated: Boolean(token && user),
        isAdmin,
        isLoading,
        latestTermsVersion,
        hasTerms,
        termsResolved,
        hasAcceptedCurrentTerms,
        login,
        signup,
        completeOidcLogin,
        logout,
        refreshUser,
        acceptCurrentTerms,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
};
