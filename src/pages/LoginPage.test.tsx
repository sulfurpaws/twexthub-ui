import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPage } from './LoginPage';
import { api, ApiError } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { makeAuthState, noop } from '../test/testUtils';

vi.mock('../services/api');
vi.mock('../context/AuthContext');

const apiMock = vi.mocked(api);
const useAuthMock = vi.mocked(useAuth);
let authState: ReturnType<typeof makeAuthState>;

beforeEach(() => {
  window.history.replaceState(null, '', '/login');
  apiMock.getAuthDescriptor.mockResolvedValue({ passwordAuth: true, oidc: null });
  authState = makeAuthState({ user: null, token: null, isAuthenticated: false });
  useAuthMock.mockReset();
  useAuthMock.mockReturnValue(authState);
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('LoginPage', () => {
  const namespaceInput = () => screen.getByPlaceholderText('your-username');
  const passwordInput = () => screen.getByLabelText('Password');

  it('renders the sign-in form', () => {
    render(<LoginPage onNavigate={noop} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in to Twext' })).toBeInTheDocument();
    expect(namespaceInput()).toBeInTheDocument();
    expect(passwordInput()).toBeInTheDocument();
  });

  it('validates empty submissions', () => {
    render(<LoginPage onNavigate={noop} />);
    const form = document.querySelector('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    expect(screen.getByText('Please enter your username and password.')).toBeInTheDocument();
    expect(authState.login).not.toHaveBeenCalled();
  });

  it('logs in with a lowercased namespace and navigates to the dashboard', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<LoginPage onNavigate={onNavigate} />);
    await user.type(namespaceInput(), 'Kane');
    await user.type(passwordInput(), 'secret');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(authState.login).toHaveBeenCalledWith('kane', 'secret');
    expect(onNavigate).toHaveBeenCalledWith('dashboard');
  });

  it('surfaces authentication errors', async () => {
    authState.login.mockRejectedValue(new ApiError('Invalid credentials.', 401));
    const user = userEvent.setup();
    render(<LoginPage onNavigate={noop} />);
    await user.type(namespaceInput(), 'kane');
    await user.type(passwordInput(), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Invalid credentials.')).toBeInTheDocument();
  });

  it('links to the signup page', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<LoginPage onNavigate={onNavigate} />);
    await user.click(screen.getByRole('button', { name: /Sign up/ }));
    expect(onNavigate).toHaveBeenCalledWith('signup');
  });

  it('offers the identity provider when one is configured', async () => {
    apiMock.getAuthDescriptor.mockResolvedValue({
      passwordAuth: true,
      oidc: { issuer: 'https://idp.example', required: false },
    });
    render(<LoginPage onNavigate={noop} />);
    expect(
      await screen.findByRole('button', { name: /Continue with identity provider/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('hides the password form when the provider is the only way in', async () => {
    apiMock.getAuthDescriptor.mockResolvedValue({
      passwordAuth: false,
      oidc: { issuer: 'https://idp.example', required: true },
    });
    render(<LoginPage onNavigate={noop} />);
    expect(
      await screen.findByRole('button', { name: /Continue with identity provider/ }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('redeems a callback code and navigates to the dashboard', async () => {
    const onNavigate = vi.fn();
    window.history.replaceState(null, '', '/login?oidc_code=one-time');
    render(<LoginPage onNavigate={onNavigate} />);
    await waitFor(() => expect(authState.completeOidcLogin).toHaveBeenCalledWith('one-time'));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('dashboard'));
    expect(window.location.search).toBe('');
  });

  it('surfaces a provider error carried back in the URL', async () => {
    window.history.replaceState(null, '', '/login?oidc_error=provider_unavailable');
    render(<LoginPage onNavigate={noop} />);
    expect(
      await screen.findByText('The identity provider could not be reached. Please try again later.'),
    ).toBeInTheDocument();
  });
});
