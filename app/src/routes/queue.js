'use strict';

const express = require('express');

/**
 * Waiting room pages and polling API (FR-P2). Polling, not SSE: a small JSON
 * request every few seconds is light on slow mobile connections.
 *   GET  /waiting       the page (position, estimated wait, auto-refresh)
 *   POST /queue/join    take a ticket (CSRF; ticket in an HttpOnly cookie)
 *   GET  /queue/status  position and estimate; when admitted, the sign-in pass cookie
 */
function queueRouter({ csrf, waitingRoom, getPolicy, cookies }) {
  const router = express.Router();

  router.get('/waiting', csrf.ensurePreSession, (req, res) => {
    res.render('waiting', { title: 'Waiting room', csrfToken: csrf.generateCsrfToken(req, res) });
  });

  router.post('/queue/join', async (req, res) => {
    const policy = await getPolicy();
    const existing = req.cookies[cookies.names.queueTicket];
    if (existing) {
      const now = await waitingRoom.status(existing, policy);
      if (now.state === 'waiting') return res.json({ state: 'waiting', position: now.position, etaSec: now.etaSec });
      if (now.state === 'admitted') return admitted(res, now.pass);
    }
    if (!policy.queue_enabled) return res.json({ state: 'admitted' });
    const { ticket, position, etaSec } = await waitingRoom.join(policy);
    cookies.setQueueTicket(res, ticket);
    return res.status(201).json({ state: 'waiting', position, etaSec });
  });

  router.get('/queue/status', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const policy = await getPolicy();
    if (!policy.queue_enabled) return res.json({ state: 'admitted' });
    const result = await waitingRoom.status(req.cookies[cookies.names.queueTicket], policy);
    if (result.state === 'admitted') return admitted(res, result.pass);
    if (result.state === 'expired') {
      cookies.clearQueueTicket(res);
      return res.json({ state: 'expired' });
    }
    return res.json({ state: 'waiting', position: result.position, etaSec: result.etaSec, pollSec: 3 });
  });

  function admitted(res, pass) {
    cookies.clearQueueTicket(res);
    cookies.setAdmissionPass(res, pass);
    return res.json({ state: 'admitted' });
  }

  return router;
}

module.exports = { queueRouter };
