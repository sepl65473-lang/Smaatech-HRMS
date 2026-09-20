// The login screen offers two ways into the SAME account: the workspace email
// or the mobile number an admin stored on the employee record. These pin that
// the chosen identifier is the one actually sent, because sending an email
// payload to the mobile route (or the reverse) fails as "invalid credentials"
// with nothing on screen to explain why.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginScreen from './LoginScreen';
import { HRMSContext } from '../context/HRMSContext';

function renderLogin(overrides = {}) {
  const value = {
    login: vi.fn(async () => ({ accessToken: 't', user: { email: 'someone@example.com' } })),
    loginWithMobile: vi.fn(async () => ({ accessToken: 't', user: { email: 'someone@example.com' } })),
    finishLogin: vi.fn(async () => {}),
    forgotPassword: vi.fn(),
    resetPassword: vi.fn(),
    settings: {},
    toast: vi.fn(),
    ...overrides,
  };
  render(
    <HRMSContext.Provider value={value}>
      <LoginScreen />
    </HRMSContext.Provider>,
  );
  return value;
}

describe('LoginScreen', () => {
  it('signs in with email by default', async () => {
    const user = userEvent.setup();
    const ctx = renderLogin();

    await user.type(screen.getByPlaceholderText('you@smaatech.co'), 'someone@example.com');
    await user.type(screen.getByPlaceholderText('••••••••'), 'CorrectPass123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(ctx.login).toHaveBeenCalledWith('someone@example.com', 'CorrectPass123'));
    expect(ctx.loginWithMobile).not.toHaveBeenCalled();
    expect(ctx.finishLogin).toHaveBeenCalled();
  });

  it('switches to the mobile number and sends it to the mobile route', async () => {
    const user = userEvent.setup();
    const ctx = renderLogin();

    await user.click(screen.getByRole('button', { name: 'Use mobile number instead' }));
    await user.type(screen.getByPlaceholderText('+91 98765 43210'), '9876543210');
    await user.type(screen.getByPlaceholderText('••••••••'), 'CorrectPass123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(ctx.loginWithMobile).toHaveBeenCalledWith('9876543210', 'CorrectPass123'));
    expect(ctx.login).not.toHaveBeenCalled();
  });

  it('switches back to email, and the email field is what is submitted', async () => {
    const user = userEvent.setup();
    const ctx = renderLogin();

    await user.click(screen.getByRole('button', { name: 'Use mobile number instead' }));
    await user.click(screen.getByRole('button', { name: 'Use email instead' }));
    await user.type(screen.getByPlaceholderText('you@smaatech.co'), 'someone@example.com');
    await user.type(screen.getByPlaceholderText('••••••••'), 'CorrectPass123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(ctx.login).toHaveBeenCalled());
    expect(ctx.loginWithMobile).not.toHaveBeenCalled();
  });

  it("shows the server's rejection instead of signing in", async () => {
    const user = userEvent.setup();
    const ctx = renderLogin({
      loginWithMobile: vi.fn(async () => { throw new Error('Invalid mobile number or password.'); }),
    });

    await user.click(screen.getByRole('button', { name: 'Use mobile number instead' }));
    await user.type(screen.getByPlaceholderText('+91 98765 43210'), '9000000000');
    await user.type(screen.getByPlaceholderText('••••••••'), 'CorrectPass123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Invalid mobile number or password.')).toBeTruthy();
    expect(ctx.finishLogin).not.toHaveBeenCalled();
  });
});
