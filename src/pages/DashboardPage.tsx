import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import { ExtensionSummary, PaginatedList, VersionInfo } from '../types/api';
import { ExtensionCard } from '../components/ExtensionCard';
import { WebhookPanel } from '../components/WebhookPanel';
import { Icon } from '../components/Icon';

interface DashboardPageProps {
  onNavigate: (route: string) => void;
}

interface PendingVersionItem {
  extension: ExtensionSummary;
  version: VersionInfo;
}

/**
 * Walks a cursor-paginated endpoint to its end so a dashboard tile counts
 * everything the account owns, not just the first page.
 */
async function fetchAllPages<T>(
  fetcher: (params?: { cursor?: string; limit?: number }) => Promise<PaginatedList<T>>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  let guard = 0;
  do {
    const res = await fetcher(cursor ? { cursor, limit: 50 } : { limit: 50 });
    all.push(...(res?.data || []));
    cursor = res?.pagination?.hasMore ? res.pagination.nextCursor || undefined : undefined;
    guard += 1;
  } while (cursor && guard < 1000);
  return all;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ onNavigate }) => {
  const { user, isAuthenticated, isLoading } = useAuth();
  const [userExtensions, setUserExtensions] = useState<ExtensionSummary[]>([]);
  const [loadingExts, setLoadingExts] = useState(true);
  const [extensionsError, setExtensionsError] = useState<string | null>(null);
  const [webhooksFor, setWebhooksFor] = useState<{ namespace: string; id: string } | null>(null);
  const [pendingVersions, setPendingVersions] = useState<PendingVersionItem[]>([]);
  const [rejectedVersions, setRejectedVersions] = useState<PendingVersionItem[]>([]);
  const [loadingPending, setLoadingPending] = useState(false);
  const [pendingError, setPendingError] = useState<string | null>(null);

  // Async loads can outlive the state they started from (a user switch, or a
  // newer extensions list). Each load takes a generation and re-reads the latest
  // namespace/extensions below; a result is only applied while all three still
  // match, so a slower, stale completion cannot overwrite current data.
  const extensionsGenerationRef = useRef(0);
  const pendingGenerationRef = useRef(0);
  const userNamespaceRef = useRef<string | null>(null);
  const userExtensionsRef = useRef<ExtensionSummary[]>(userExtensions);

  // Written after every committed render, never during one, so the guards below
  // only ever compare against state the user actually saw.
  useLayoutEffect(() => {
    userNamespaceRef.current = user?.namespace ?? null;
    userExtensionsRef.current = userExtensions;
  }, [user, userExtensions]);

  const loadUserExtensions = useCallback(async () => {
    if (!user) return;
    const generation = ++extensionsGenerationRef.current;
    const namespace = user.namespace;
    setLoadingExts(true);
    setExtensionsError(null);
    try {
      // Search is namespace-scoped but still paginated, so walk every page and
      // then keep strictly to the user's own namespace.
      const all = await fetchAllPages((params) => api.searchExtensions(namespace, params));
      if (extensionsGenerationRef.current !== generation) return;
      if (userNamespaceRef.current !== namespace) return;
      setUserExtensions(all.filter((ext) => ext.namespace === namespace));
    } catch {
      // Keep whatever was already loaded; a failed refresh must not look like an
      // empty account.
      if (extensionsGenerationRef.current !== generation) return;
      if (userNamespaceRef.current !== namespace) return;
      setExtensionsError('Could not load your extensions. Please try again.');
    } finally {
      if (extensionsGenerationRef.current === generation) {
        setLoadingExts(false);
      }
    }
  }, [user]);

  const loadPending = useCallback(async () => {
    const generation = ++pendingGenerationRef.current;
    const namespace = user?.namespace ?? null;
    const extensions = userExtensions;
    if (!user || extensions.length === 0) {
      if (pendingGenerationRef.current === generation) {
        setPendingVersions([]);
        setRejectedVersions([]);
        setPendingError(null);
        setLoadingPending(false);
      }
      return;
    }
    setLoadingPending(true);
    setPendingError(null);
    let failed = 0;
    try {
      const pending: PendingVersionItem[] = [];
      const rejected: PendingVersionItem[] = [];
      for (const ext of extensions) {
        // Each status is paged to the end; a failure here is counted rather than
        // silently shown as "nothing pending", while other extensions proceed.
        const p = await fetchAllPages((params) =>
          api.getExtensionVersions(ext.namespace, ext.id, { ...params, status: 'pending' }),
        ).catch(() => {
          failed += 1;
          return [] as VersionInfo[];
        });
        const r = await fetchAllPages((params) =>
          api.getExtensionVersions(ext.namespace, ext.id, { ...params, status: 'rejected' }),
        ).catch(() => {
          failed += 1;
          return [] as VersionInfo[];
        });
        for (const v of p) {
          pending.push({ extension: ext, version: v });
        }
        for (const v of r) {
          rejected.push({ extension: ext, version: v });
        }
      }
      if (pendingGenerationRef.current !== generation) return;
      if (userNamespaceRef.current !== namespace) return;
      if (userExtensionsRef.current !== extensions) return;
      setPendingVersions(pending);
      setRejectedVersions(rejected);
      if (failed > 0) {
        setPendingError(
          `Could not load ${failed} review ${failed === 1 ? 'list' : 'lists'}. Some versions may be missing.`,
        );
      }
    } catch {
      if (pendingGenerationRef.current !== generation) return;
      if (userNamespaceRef.current !== namespace) return;
      if (userExtensionsRef.current !== extensions) return;
      setPendingError('Could not load every review list. Some versions may be missing.');
    } finally {
      if (pendingGenerationRef.current === generation) {
        setLoadingPending(false);
      }
    }
  }, [user, userExtensions]);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      onNavigate('login');
      return;
    }

    if (user) {
      loadUserExtensions();
    }
  }, [isAuthenticated, isLoading, user, onNavigate, loadUserExtensions]);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-12 space-y-6">
        <div className="h-28 bg-wash dark:bg-raised rounded-lg animate-pulse" />
        <div className="h-64 bg-wash dark:bg-raised rounded-lg animate-pulse" />
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center space-y-4">
        <p className="text-xs text-ink-3">Redirecting to login...</p>
      </div>
    );
  }

  const publishedCount = userExtensions.length;
  const pendingCount = pendingVersions.length;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Top Welcome & Account Overview */}
      <div className="card p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-lg bg-wash dark:bg-raised border border-line flex items-center justify-center text-ink-2 font-bold text-xl shrink-0">
              {(user.displayName || user.namespace).charAt(0).toUpperCase()}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-display font-semibold text-ink">
                  {user.displayName || user.namespace}
                </h1>
                <span className="chip bg-wash dark:bg-raised border-line text-ink-2 font-mono text-xs">
                  @{user.namespace}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-ink-3 mt-1">
                <span>Member since {new Date(user.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <button onClick={() => onNavigate('settings')} className="btn btn-secondary">
              <Icon name="settings" className="icon-sm" />
              Settings
            </button>
          </div>
        </div>
      </div>

      {/* User's Published & Pending Extensions */}
      <div className="space-y-4">
        <div className="flex items-center justify-between pb-2 border-b border-line">
          <div>
            <h2 className="text-xl font-display font-semibold text-ink">Your Extensions</h2>
            <p className="text-xs text-ink-3">
              Extensions authored under your @{user.namespace} namespace ({publishedCount}{' '}
              published, {pendingCount} pending).
            </p>
          </div>
        </div>

        {loadingExts ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="h-40 bg-wash dark:bg-raised rounded-lg border border-line animate-pulse"
              />
            ))}
          </div>
        ) : (
          <>
            {extensionsError && (
              <div role="alert" data-tone="danger" className="alert items-center text-xs">
                <Icon name="error" className="shrink-0" />
                <div className="min-w-0 flex-1 leading-tight">{extensionsError}</div>
                <button
                  type="button"
                  onClick={() => void loadUserExtensions()}
                  disabled={loadingExts}
                  className="btn btn-secondary btn-sm disabled:opacity-50"
                >
                  Retry
                </button>
              </div>
            )}

            {userExtensions.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {userExtensions.map((ext) => (
                  <ExtensionCard
                    key={`${ext.namespace}/${ext.id}`}
                    extension={ext}
                    onClick={() => onNavigate(`ext/${ext.namespace}/${ext.id}`)}
                  />
                ))}
              </div>
            ) : !extensionsError ? (
              <div className="border border-line rounded-lg bg-surface p-5 space-y-2">
                <p className="text-sm font-semibold text-ink">
                  No extensions under @{user.namespace} yet
                </p>
                <p className="text-xs text-ink-3 max-w-lg leading-relaxed">
                  Ready to share your custom TurboWarp blocks? Compile and publish them with the
                  Twext CLI.
                </p>
              </div>
            ) : null}
          </>
        )}
      </div>

      {pendingError && (
        <div role="alert" data-tone="danger" className="alert items-center text-xs">
          <Icon name="error" className="shrink-0" />
          <div className="min-w-0 flex-1 leading-tight">{pendingError}</div>
          <button
            type="button"
            onClick={() => void loadPending()}
            disabled={loadingPending}
            className="btn btn-secondary btn-sm disabled:opacity-50"
          >
            Retry
          </button>
        </div>
      )}

      {(pendingVersions.length > 0 || rejectedVersions.length > 0) && (
        <div className="space-y-4">
          <div className="flex items-center justify-between pb-2 border-b border-line">
            <div>
              <h2 className="text-xl font-display font-semibold text-ink">In Review</h2>
              <p className="text-xs text-ink-3">
                Versions awaiting approval or that were rejected.
              </p>
            </div>
          </div>
          <div className="space-y-4">
            {pendingVersions.length > 0 && (
              <div className="border border-line rounded-lg divide-y divide-line">
                <div className="px-4 py-2 text-xs font-semibold text-ink bg-wash/50">
                  Pending ({pendingVersions.length})
                </div>
                {pendingVersions.map((item, idx) => (
                  <div
                    key={`${item.extension.namespace}/${item.extension.id}/${item.version.version}-${idx}`}
                    className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-ink">
                          {item.extension.name} v{item.version.version}
                        </span>
                        <span className="chip bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800 text-micro">
                          pending
                        </span>
                      </div>
                      <div className="font-mono text-meta text-ink-3">
                        @{item.extension.namespace}/{item.extension.id}
                      </div>
                    </div>
                    <button
                      onClick={() =>
                        onNavigate(
                          `ext/${item.extension.namespace}/${item.extension.id}?version=${encodeURIComponent(item.version.version)}`,
                        )
                      }
                      className="btn btn-secondary btn-sm"
                    >
                      View
                    </button>
                  </div>
                ))}
              </div>
            )}
            {rejectedVersions.length > 0 && (
              <div className="border border-line rounded-lg divide-y divide-line">
                <div className="px-4 py-2 text-xs font-semibold text-ink bg-wash/50">
                  Rejected ({rejectedVersions.length})
                </div>
                {rejectedVersions.map((item, idx) => (
                  <div
                    key={`${item.extension.namespace}/${item.extension.id}/${item.version.version}-${idx}`}
                    className="p-4 flex flex-col gap-2"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-ink">
                            {item.extension.name} v{item.version.version}
                          </span>
                          <span className="chip bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800 text-micro">
                            rejected
                          </span>
                        </div>
                        <div className="font-mono text-meta text-ink-3">
                          @{item.extension.namespace}/{item.extension.id}
                        </div>
                      </div>
                      <button
                        onClick={() =>
                          onNavigate(
                            `ext/${item.extension.namespace}/${item.extension.id}?version=${encodeURIComponent(item.version.version)}`,
                          )
                        }
                        className="btn btn-secondary btn-sm"
                      >
                        View
                      </button>
                    </div>
                    {item.version.rejectionReason && (
                      <div className="text-xs text-ink-2 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 rounded p-2">
                        {item.version.rejectionReason}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Webhooks are per-extension, so they are surfaced here per extension. */}
      {userExtensions.length > 0 && (
        <div className="space-y-4">
          <div className="pb-2 border-b border-line">
            <h2 className="text-xl font-display font-semibold text-ink flex items-center gap-2">
              <Icon name="webhook" className="icon-lg text-lilac-700 dark:text-lilac-300" />
              Webhooks
            </h2>
            <p className="text-xs text-ink-3 mt-1 max-w-2xl leading-relaxed">
              Each extension gets its own webhooks. TwextHub sends a signed event to your URL when a
              version is published, unpublished, deprecated, rejected, or changes owner. The signing
              secret is shown once when the webhook is created.
            </p>
          </div>
          <div className="divide-y divide-line border border-line rounded-lg">
            {userExtensions.map((ext) => (
              <div
                key={`${ext.namespace}/${ext.id}`}
                className="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink truncate">{ext.name}</div>
                  <div className="font-mono text-meta text-ink-3 truncate">
                    @{ext.namespace}/{ext.id}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => onNavigate(`ext/${ext.namespace}/${ext.id}`)}
                    className="btn btn-secondary btn-sm"
                  >
                    View
                  </button>
                  <button
                    onClick={() => setWebhooksFor({ namespace: ext.namespace, id: ext.id })}
                    className="btn btn-secondary btn-sm"
                  >
                    <Icon name="webhook" className="icon-sm" />
                    Manage webhooks
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {webhooksFor && (
        <WebhookPanel
          namespace={webhooksFor.namespace}
          id={webhooksFor.id}
          onClose={() => setWebhooksFor(null)}
        />
      )}
    </div>
  );
};
