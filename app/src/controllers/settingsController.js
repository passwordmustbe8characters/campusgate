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

  async function startTotp(req, res) {
    const { qrDataUrl, secret } = await settingsService.startTotp(req.account.userId, { log: req.log });
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      message: 'Scan the QR code with your authenticator app (or type the key), then enter the 6-digit code it shows.',
      qrDataUrl,
      secret,
    });
  }

  async function confirmTotp(req, res) {
    const { backupCodes } = await settingsService.confirmTotp(req.account.userId, req.body.code, { log: req.log });
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      message: 'Authenticator app is on. Save these backup codes now: each works once, and they will not be shown again.',
      backupCodes,
    });
  }

  return { startEmail2fa, confirmEmail2fa, startTotp, confirmTotp };
}

module.exports = { createSettingsController };
