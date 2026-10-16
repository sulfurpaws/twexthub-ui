import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { AuthDescriptor } from '../types/api';

/**
 * Human wording for the slugs the provider callback can carry back in
 * `oidc_error`. Unknown slugs fall through to the slug itself so a new failure
 * mode is still visible rather than silently swallowed.
 */
const OIDC_ERROR_MESSAGES: Record<string, string> = {
  state_invalid: 'That sign-in attempt is unknown or has expired. Please try again.',
  provider_error: 'The identity provider refused the sign-in. Please try again.',
  provider_rejected: 'The identity provider rejected the sign-in.',
  provider_unavailable: 'The identity provider could not be reached. Please try again later.',
  invalid_id_token: 'The identity provider returned an invalid response.',
  signup_failed: 'Your account could not be created. Please try again.',
  link_failed: 'The identity could not be linked. Please try again.',
  identity_taken: 'That identity is already linked to another account.',
};

export function oidcErrorMessage(slug: string): string {
  return OIDC_ERROR_MESSAGES[slug] || `Sign-in failed (${slug}).`;
}

/**
 * Reads how the instance signs users in. The result drives whether a password
 * form and/or an identity-provider button is offered, so a page waits on it
 * rather than rendering the wrong affordance and correcting itself.
 */
export function useAuthDescriptor(): {
  descriptor: AuthDescriptor | null;
  loading: boolean;
  error: string | null;
} {
  const [descriptor, setDescriptor] = useState<AuthDescriptor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .getAuthDescriptor()
      .then((result) => {
        if (active) setDescriptor(result);
      })
      .catch((err: unknown) => {
        if (active) {
          setError(err instanceof ApiError ? err.message : 'Failed to load sign-in options');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return { descriptor, loading, error };
}

/**
 * Completes a provider round-trip on the page the callback redirects back to.
 * A sign-in comes back with a one-time `oidc_code` that is traded for a
 * session; a link comes back with `oidc_linked=1`. Either way the parameters
 * are stripped from the URL so a reload does not replay them.
 */
export function useOidcCallback(options: {
  onSignedIn?: () => void;
  onLinked?: () => void;
  onError?: (message: string) => void;
}): void {
  const { completeOidcLogin } = useAuth();

  const stripParams = useCallback((...names: string[]) => {
    const params = new URLSearchParams(window.location.search);
    let changed = false;
    for (const name of names) {
      if (params.has(name)) {
        params.delete(name);
        changed = true;
      }
    }
    if (changed) {
      const qs = params.toString();
      const next = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
      window.history.replaceState(null, '', next);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('oidc_code');
    const errorSlug = params.get('oidc_error');
    const linked = params.get('oidc_linked');

    if (code) {
      stripParams('oidc_code');
      completeOidcLogin(code)
        .then((signedIn) => {
          // A superseded exchange reports `false`; do not treat it as a login.
          if (signedIn) options.onSignedIn?.();
        })
        .catch((err: unknown) => {
          options.onError?.(
            err instanceof ApiError ? err.message : 'Sign-in could not be completed.',
          );
        });
      return;
    }
    if (errorSlug) {
      stripParams('oidc_error');
      options.onError?.(oidcErrorMessage(errorSlug));
      return;
    }
    if (linked) {
      stripParams('oidc_linked');
      options.onLinked?.();
    }
    // Only the callback parameters matter; the callbacks are stable enough that
    // re-running on identity changes would replay a consumed code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
