'use strict';

const REGISTRATION_REJECTED =
  "We couldn't register this account. Check your matric number and email address. " +
  'If you already have an account, sign in instead or contact the registry.';

// One message for every login failure (FR-A5): wrong password, unknown user,
// inactive account, and locked account all look identical.
const loginFailedMessage = (policy) =>
  `Invalid ID or password. After repeated failures, sign-in is paused for ${policy.lockout_minutes} minutes.`;

function createAuthController(authService) {
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
    // Phase 1 proves the credentials only; the session cookie arrives in Phase 4.
    return res.status(200).json({ message: 'Signed in.', role: result.user.role });
  }

  return { register, login };
}

module.exports = { createAuthController, REGISTRATION_REJECTED, loginFailedMessage };
