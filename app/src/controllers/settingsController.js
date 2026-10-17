'use strict';

/** Security-settings endpoints. Every route here sits behind requireAccountTicket. */
function createSettingsController({ settingsService }) {
  async function startEmail2fa(req, res) {
    await settingsService.startEmail2fa(req.account.userId, { log: req.log });
    res.status(200).json({ message: 'We sent a 6-digit code to your email. Enter it to turn on two-step sign-in.' });
  }

  async function confirmEmail2fa(req, res) {
    await settingsService.confirmEmail2fa(req.account.userId, req.body.code, { log: req.log });
    res.status(200).json({ message: 'Two-step sign-in with email codes is now on.' });
  }

  return { startEmail2fa, confirmEmail2fa };
}

module.exports = { createSettingsController };
