import React, { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../services/api';
import { Pagination, Webhook, WebhookDelivery, WebhookDeliveryStatus } from '../types/api';
import { Icon } from './Icon';
import { Modal } from './Modal';

interface WebhookDeliveryLogProps {
  namespace: string;
  /**
   * Which collection the webhook lives in, mirroring `WebhookPanel`: an
   * extension (`id`), the account (`account`), or the organization.
   */
  id?: string;
  organization?: boolean;
  account?: boolean;
  webhook: Webhook;
  onClose: () => void;
}

const STATUS_LABELS: Record<WebhookDeliveryStatus, string> = {
  pending: 'Pending',
  delivering: 'Delivering',
  retrying: 'Retrying',
  delivered: 'Delivered',
  failed: 'Failed',
};

const statusTone = (status: WebhookDeliveryStatus): string => {
  switch (status) {
    case 'delivered':
      return 'bg-emerald-50 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/60';
    case 'failed':
      return 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900/60';
    case 'retrying':
      return 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800/60';
    default:
      return 'bg-wash dark:bg-raised text-ink-2 border-line';
  }
};

export const WebhookDeliveryLog: React.FC<WebhookDeliveryLogProps> = ({
  namespace,
  id,
  organization = false,
  account = false,
  webhook,
  onClose,
}) => {
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<Pagination>({ nextCursor: null, hasMore: false });
  const [redeliveringId, setRedeliveringId] = useState<number | null>(null);

  const fetchPage = useCallback(
    (cursor?: string) =>
      organization
        ? api.getOrganizationWebhookDeliveries(namespace, webhook.id, { cursor })
        : account
          ? api.getUserWebhookDeliveries(namespace, webhook.id, { cursor })
          : api.getWebhookDeliveries(namespace, id as string, webhook.id, { cursor }),
    [organization, account, namespace, id, webhook.id],
  );

  const load = useCallback(
    async (cursor?: string) => {
      if (cursor) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const page = await fetchPage(cursor);
        setDeliveries((prev) => (cursor ? [...prev, ...page.data] : page.data));
        setPagination(page.pagination);
      } catch (err: unknown) {
        setError(err instanceof ApiError ? err.message : 'Failed to load deliveries');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [fetchPage],
  );

  useEffect(() => {
    load();
  }, [load]);

  const handleRedeliver = async (delivery: WebhookDelivery) => {
    setRedeliveringId(delivery.id);
    setError(null);
    try {
      const updated = organization
        ? await api.redeliverOrganizationWebhook(namespace, webhook.id, delivery.id)
        : account
          ? await api.redeliverUserWebhook(namespace, webhook.id, delivery.id)
          : await api.redeliverWebhook(namespace, id as string, webhook.id, delivery.id);
      setDeliveries((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'Failed to redeliver');
    } finally {
      setRedeliveringId(null);
    }
  };

  return (
    <Modal
      onClose={onClose}
      size="2xl"
      zIndex={60}
      ariaLabel={`Deliveries for ${webhook.url}`}
      className="p-5 space-y-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink flex items-center gap-2 min-w-0">
          <Icon name="webhook" className="text-lilac-500 dark:text-lilac-300 shrink-0" />
          <span className="truncate">Deliveries — {webhook.url}</span>
        </h2>
        <button
          onClick={onClose}
          aria-label="Close"
          className="text-ink-3 hover:text-ink p-1 rounded-md hover:bg-wash transition-colors shrink-0"
        >
          <Icon name="close" />
        </button>
      </div>

      {error && (
        <div data-tone="danger" className="alert items-center text-xs">
          <Icon name="error" className="shrink-0" />
          <div className="leading-tight">{error}</div>
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          <div className="h-16 bg-wash dark:bg-raised rounded animate-pulse" />
          <div className="h-16 bg-wash dark:bg-raised rounded animate-pulse" />
        </div>
      ) : deliveries.length > 0 ? (
        <div className="divide-y divide-line border border-line rounded-lg max-h-[60vh] overflow-y-auto">
          {deliveries.map((delivery) => (
            <div key={delivery.id} className="p-3 space-y-1.5 text-xs bg-surface dark:bg-raised">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`chip border text-micro shrink-0 ${statusTone(delivery.status)}`}
                  >
                    {STATUS_LABELS[delivery.status]}
                  </span>
                  <code className="font-mono text-ink truncate">{delivery.event}</code>
                </div>
                <button
                  onClick={() => handleRedeliver(delivery)}
                  disabled={redeliveringId === delivery.id}
                  className="btn btn-secondary btn-sm shrink-0 disabled:opacity-50"
                >
                  <Icon name="refresh" className="icon-xs" />
                  <span>{redeliveringId === delivery.id ? 'Retrying...' : 'Retry'}</span>
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-ink-3">
                <span>
                  Attempt {delivery.attempt}/{delivery.maxAttempts}
                </span>
                <span>• {new Date(delivery.createdAt).toLocaleString()}</span>
                {delivery.nextAttemptAt && delivery.status === 'retrying' && (
                  <span>• Next try {new Date(delivery.nextAttemptAt).toLocaleString()}</span>
                )}
              </div>
              {delivery.lastError && (
                <div className="text-meta text-rose-700 dark:text-rose-400 break-words">
                  {delivery.lastError}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-meta text-ink-3 py-2">No deliveries recorded yet.</p>
      )}

      {pagination.hasMore && (
        <div className="text-center">
          <button
            onClick={() => load(pagination.nextCursor || undefined)}
            disabled={loadingMore}
            className="btn btn-secondary btn-sm disabled:opacity-50"
          >
            {loadingMore ? 'Loading...' : 'Load more'}
          </button>
        </div>
      )}
    </Modal>
  );
};
