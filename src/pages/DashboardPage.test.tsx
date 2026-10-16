import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DashboardPage } from './DashboardPage';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import {
  makeAuthState,
  makeExtension,
  makePendingVersion,
  makeUser,
  paginated,
  noop,
} from '../test/testUtils';

vi.mock('../services/api');
vi.mock('../context/AuthContext');

const apiMock = vi.mocked(api);
const useAuthMock = vi.mocked(useAuth);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  apiMock.searchExtensions.mockResolvedValue(paginated([makeExtension()]));
  apiMock.getWebhooks.mockResolvedValue([]);
  useAuthMock.mockReset();
  useAuthMock.mockReturnValue(makeAuthState());
});

describe('DashboardPage', () => {
  it('renders the profile header and a settings action', async () => {
    render(<DashboardPage onNavigate={noop} />);
    expect(await screen.findByText('Your Extensions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
  });

  it('navigates to settings from the header action', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<DashboardPage onNavigate={onNavigate} />);
    await screen.findByText('Your Extensions');
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onNavigate).toHaveBeenCalledWith('settings');
  });

  it('lists extensions owned by the current user', async () => {
    render(<DashboardPage onNavigate={noop} />);
    // The name appears in the extension card and again in the webhook row.
    expect((await screen.findAllByText('Demo Extension')).length).toBeGreaterThan(0);
    expect(apiMock.searchExtensions).toHaveBeenCalledWith('kane', { limit: 50 });
  });

  it('surfaces webhook management per extension', async () => {
    const user = userEvent.setup();
    render(<DashboardPage onNavigate={noop} />);
    await screen.findByText('Your Extensions');

    expect(screen.getByRole('heading', { name: 'Webhooks' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Manage webhooks' }));

    expect(apiMock.getWebhooks).toHaveBeenCalledWith('kane', 'demo');
    expect(await screen.findByRole('dialog', { name: /webhooks/i })).toBeInTheDocument();
  });

  it('hides the webhook section when the user has no extensions', async () => {
    apiMock.searchExtensions.mockResolvedValue(paginated([]));
    render(<DashboardPage onNavigate={noop} />);
    await screen.findByText(/No extensions under/);
    expect(screen.queryByRole('heading', { name: 'Webhooks' })).toBeNull();
  });

  it('shows an empty state when the user has no published extensions', async () => {
    apiMock.searchExtensions.mockResolvedValue(paginated([]));
    render(<DashboardPage onNavigate={noop} />);
    expect(await screen.findByText('No extensions under @kane yet')).toBeInTheDocument();
  });

  it('collects every page of owned extensions', async () => {
    apiMock.searchExtensions
      .mockResolvedValueOnce(paginated([makeExtension({ id: 'one' })], 'cursor-2', true))
      .mockResolvedValueOnce(paginated([makeExtension({ id: 'two' })]));
    render(<DashboardPage onNavigate={noop} />);

    await waitFor(() => expect(apiMock.searchExtensions).toHaveBeenCalledTimes(2));
    expect(apiMock.searchExtensions).toHaveBeenLastCalledWith('kane', {
      cursor: 'cursor-2',
      limit: 50,
    });
  });

  it('keeps loaded reviews and offers a retry when one list fails', async () => {
    apiMock.getExtensionVersions
      .mockResolvedValueOnce(paginated([makePendingVersion({ version: '2.0.0' })]))
      .mockRejectedValueOnce(new Error('boom'));
    render(<DashboardPage onNavigate={noop} />);

    expect(await screen.findByText('Demo Extension v2.0.0')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load 1 review list');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows a retryable error instead of the empty state when the search fails', async () => {
    apiMock.searchExtensions.mockRejectedValue(new Error('boom'));
    render(<DashboardPage onNavigate={noop} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your extensions');
    expect(screen.queryByText(/No extensions under/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('keeps loaded extensions when a later search fails', async () => {
    const { rerender } = render(<DashboardPage onNavigate={noop} />);
    expect((await screen.findAllByText('Demo Extension')).length).toBeGreaterThan(0);

    apiMock.searchExtensions.mockRejectedValue(new Error('boom'));
    useAuthMock.mockReturnValue(makeAuthState({ user: makeUser({ displayName: 'Kane Updated' }) }));
    rerender(<DashboardPage onNavigate={noop} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your extensions');
    // The previously loaded card survives the failed refresh.
    expect(screen.getAllByText('Demo Extension').length).toBeGreaterThan(0);
    expect(screen.queryByText(/No extensions under/)).toBeNull();
  });

  it('retries the extension search and renders the results', async () => {
    const user = userEvent.setup();
    apiMock.searchExtensions
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(paginated([makeExtension()]));
    render(<DashboardPage onNavigate={noop} />);

    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    expect((await screen.findAllByText('Demo Extension')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ignores a stale search that resolves after a newer one', async () => {
    const first = deferred<Awaited<ReturnType<typeof api.searchExtensions>>>();
    apiMock.searchExtensions
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(
        paginated([makeExtension({ namespace: 'ada', id: 'new', name: 'New Extension' })]),
      );

    const { rerender } = render(<DashboardPage onNavigate={noop} />);
    useAuthMock.mockReturnValue(
      makeAuthState({ user: makeUser({ namespace: 'ada', displayName: 'Ada' }) }),
    );
    rerender(<DashboardPage onNavigate={noop} />);

    await waitFor(() => expect(apiMock.searchExtensions).toHaveBeenCalledTimes(2));
    first.resolve(paginated([makeExtension({ id: 'old', name: 'Old Extension' })]));

    expect((await screen.findAllByText('New Extension')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Old Extension')).toBeNull();
  });

  it('redirects a signed-out visitor to login', async () => {
    useAuthMock.mockReturnValue(makeAuthState({ user: null, token: null, isAuthenticated: false }));
    const onNavigate = vi.fn();
    render(<DashboardPage onNavigate={onNavigate} />);
    expect(await screen.findByText('Redirecting to login...')).toBeInTheDocument();
    expect(onNavigate).toHaveBeenCalledWith('login');
  });
});
