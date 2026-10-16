import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignupPage } from './SignupPage';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { makeAuthState, noop } from '../test/testUtils';

vi.mock('../services/api');
vi.mock('../context/AuthContext');

const apiMock = vi.mocked(api);
const useAuthMock = vi.mocked(useAuth);
let authState: ReturnType<typeof makeAuthState>;

beforeEach(() => {
  window.history.replaceState(null, '', '/signup');
  apiMock.getAuthDescriptor.mockResolvedValue({ passwordAuth: true, oidc: null });
  authState = makeAuthState({
    user: null,
    token: null,
    isAuthenticated: false,
    latestTermsVersion: 4,
  });
  useAuthMock.mockReset();
  useAuthMock.mockReturnValue(authState);
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('SignupPage', () => {
  const namespaceInput = () => screen.findByPlaceholderText('your-username');
  const displayNameInput = () => screen.findByPlaceholderText('e.g. Kane Marshall');
  const passwordInput = () => screen.findByPlaceholderText('Minimum 8 characters');

  it('renders the registration form and terms version link', async () => {
    render(<SignupPage onNavigate={noop} />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Create an account' }),
    ).toBeInTheDocument();
    expect(await namespaceInput()).toBeInTheDocument();
    expect(await displayNameInput()).toBeInTheDocument();
    expect(screen.getByText('Terms of Service (v4)')).toBeInTheDocument();
  });

  it('requires a namespace and password', async () => {
    render(<SignupPage onNavigate={noop} />);
    await namespaceInput();
    const form = document.querySelector('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    expect(screen.getByText('Please choose a username and password.')).toBeInTheDocument();
  });

  it('enforces a minimum password length', async () => {
    const user = userEvent.setup();
    render(<SignupPage onNavigate={noop} />);
    await user.type(await namespaceInput(), 'kane');
    await user.type(await passwordInput(), 'short');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByText('Password must be at least 8 characters long.')).toBeInTheDocument();
  });

  it('requires agreeing to the terms', async () => {
    const user = userEvent.setup();
    render(<SignupPage onNavigate={noop} />);
    await user.type(await namespaceInput(), 'kane');
    await user.type(await passwordInput(), 'long-enough-pass');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByText(/You must agree to the Terms of Service/)).toBeInTheDocument();
  });

  it('signs up, accepts the current terms, and routes to the dashboard', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<SignupPage onNavigate={onNavigate} />);
    await user.type(await namespaceInput(), 'Kane');
    await user.type(await displayNameInput(), 'Kane Marshall');
    await user.type(await passwordInput(), 'long-enough-pass');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(authState.signup).toHaveBeenCalledWith('kane', 'long-enough-pass', 'Kane Marshall');
    expect(authState.acceptCurrentTerms).toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith('dashboard');
  });

  it('links to the login page', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<SignupPage onNavigate={onNavigate} />);
    await user.click(await screen.findByRole('button', { name: /^Sign in$/ }));
    expect(onNavigate).toHaveBeenCalledWith('login');
  });

  it('omits the terms consent and acceptance call when nothing is published', async () => {
    const onNavigate = vi.fn();
    authState = makeAuthState({
      user: null,
      token: null,
      isAuthenticated: false,
      hasTerms: false,
      latestTermsVersion: null,
    });
    useAuthMock.mockReturnValue(authState);
    const user = userEvent.setup();
    render(<SignupPage onNavigate={onNavigate} />);
    await namespaceInput();

    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/Terms of Service/)).toBeNull();

    await user.type(await namespaceInput(), 'kane');
    await user.type(await passwordInput(), 'long-enough-pass');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(authState.signup).toHaveBeenCalled();
    expect(authState.acceptCurrentTerms).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith('dashboard');
  });

  it('offers signing up through the provider when one is configured', async () => {
    apiMock.getAuthDescriptor.mockResolvedValue({
      passwordAuth: true,
      oidc: { issuer: 'https://idp.example', required: false },
    });
    render(<SignupPage onNavigate={noop} />);
    expect(
      await screen.findByRole('button', { name: /Sign up with identity provider/ }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Minimum 8 characters')).toBeInTheDocument();
  });

  it('hides the password form when the provider is the only way in', async () => {
    apiMock.getAuthDescriptor.mockResolvedValue({
      passwordAuth: false,
      oidc: { issuer: 'https://idp.example', required: true },
    });
    render(<SignupPage onNavigate={noop} />);
    expect(
      await screen.findByRole('button', { name: /Sign up with identity provider/ }),
    ).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Minimum 8 characters')).not.toBeInTheDocument();
  });

  it('completes a provider sign-up carried back in the URL', async () => {
    const onNavigate = vi.fn();
    window.history.replaceState(null, '', '/signup?oidc_code=one-time');
    render(<SignupPage onNavigate={onNavigate} />);
    await waitFor(() => expect(authState.completeOidcLogin).toHaveBeenCalledWith('one-time'));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('dashboard'));
  });
});
