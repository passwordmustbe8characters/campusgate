'use strict';

const REGISTRATION_REJECTED =
  "We couldn't register this account. Check your matric number and email address. " +
  'If you already have an account, sign in instead or contact the registry.';

// One message for every login failure (FR-A5): wrong password, unknown user,
// inactive account, and locked account all look identical.
const loginFailedMessage = (policy) =>
  `Invalid ID or password. After repeated failures, sign-in is paused for ${policy.lockout_minutes} minutes.`;

const RESTART_MESSAGE = 'Your sign-in has expired. Please sign in again.';
const INVALID_CODE_MESSAGE = 'Invalid or expired code.';

/**
 * Full sign-in completed. Phase 2 issues only the interim account ticket
 * (security settings only). TODO(Phase 4): issue the JWT session here instead.
 *
 * The ticket lives in Redis. If Redis is down, a password-only sign-in still
 * succeeds (Phase 1 behaviour); only the security-settings page is unavailable.
 * 2FA sign-in cannot get this far without Redis (the pre-auth ticket is there).
 */
async function signIn(req, res, user, { accountTickets, cookies }) {
  cookies.clearPreauth(res);
  try {
    cookies.setAccount(res, await accountTickets.issue({ userId: user.id, role: user.role }));
  } catch (err) {
    req.log.warn({ event: 'account_ticket_unavailable', userId: user.id, err }, 'signed in without account ticket');
  }
  return res.status(200).json({ status: 'signed_in', message: 'Signed in.', role: user.role });
}

function createAuthController({ authService, secondFactor, accountTickets, cookies }) {
  const ticketDeps = { accountTickets, cookies };

  async function register(req, res) {
    const { matricNo, email, password } = req.body;
    const result = await authService.register({ matricNo, email, password }, { log: req.log });

    if (result.ok) {
      return res.status(201).json({ message: 'Account created. You can now sign in.' });
    }
    if (result.kind === 'invalid') {
      return res.status(400).json({ error: 'Please correct the highlighted fields.', fields: result.fields });
    }
    return res.status(400).json({ error: REGISTRATION_REJECTED });
  }

  async function login(req, res) {
    const { identifier, password } = req.body;
    const result = await authService.login({ identifier, password }, { log: req.log });

    if (!result.ok) {
      return res.status(401).json({ error: loginFailedMessage(result.policy) });
    }
    if (result.status === 'signed_in') return signIn(req, res, result.user, ticketDeps);

    // Password correct, second factor pending.
    const started = await secondFactor.start(result.user, { log: req.log });
    cookies.setPreauth(res, started.ticket);
    const body = { status: 'second_factor_required', method: started.method };
    if (started.method === 'email') {
      body.codeSent = started.codeSent;
      if (started.deliveryFailed) body.message = "We couldn't send your code. Please use Resend.";
      else if (started.retryAfterSec) body.message = `A code was sent recently. Check your email, or resend in ${started.retryAfterSec} s.`;
      else body.message = 'We sent a 6-digit code to your email.';
    } else {
      body.message = 'Enter the 6-digit code from your authenticator app, or a backup code.';
    }
    return res.status(200).json(body);
  }

  /** POST /auth/otp, /auth/totp/verify: second step of sign-in. */
  const verifySecondFactor = (method, field) => async (req, res) => {
    const result = await secondFactor.verify(req.cookies[cookies.names.preauth], method, req.body[field], { log: req.log });
    if (result.status === 'signed_in') return signIn(req, res, result.user, ticketDeps);
    if (result.status === 'restart') {
      cookies.clearPreauth(res);
      return res.status(401).json({ error: RESTART_MESSAGE, restart: true });
    }
    return res.status(401).json({ error: INVALID_CODE_MESSAGE });
  };

  async function resendOtp(req, res) {
    const result = await secondFactor.resend(req.cookies[cookies.names.preauth], { log: req.log });
    if (result.status === 'restart') {
      cookies.clearPreauth(res);
      return res.status(401).json({ error: RESTART_MESSAGE, restart: true });
    }
    return res.status(200).json({ message: 'We sent a new code to your email.' });
  }

  return { register, login, verifySecondFactor, resendOtp };
}

module.exports = {
  createAuthController, REGISTRATION_REJECTED, loginFailedMessage, RESTART_MESSAGE, INVALID_CODE_MESSAGE,
};
