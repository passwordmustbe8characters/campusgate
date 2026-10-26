// Waiting room (FR-P2): take a ticket, then poll for position until admitted.
(function () {
  'use strict';

  var csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
  var position = document.querySelector('[data-position]');
  var eta = document.querySelector('[data-eta]');
  var message = document.querySelector('[data-queue-message]');
  var failures = 0;

  function describeWait(sec) {
    if (sec < 60) return 'under a minute';
    var min = Math.round(sec / 60);
    return 'about ' + min + ' minute' + (min === 1 ? '' : 's');
  }

  function show(body) {
    if (body.state === 'admitted') {
      message.textContent = "It's your turn. Taking you to sign in…";
      window.location.assign('/login?admitted=1');
      return null;
    }
    if (body.state === 'expired') {
      message.textContent = 'Your place expired. Joining the queue again…';
      return join();
    }
    position.textContent = String(body.position);
    eta.textContent = describeWait(body.etaSec);
    return schedule((body.pollSec || 3) * 1000);
  }

  function schedule(ms) {
    setTimeout(poll, ms);
    return null;
  }

  function handle(promise) {
    return promise
      .then(function (res) {
        if (!res.ok) throw new Error('status ' + res.status);
        failures = 0;
        return res.json();
      })
      .then(show)
      .catch(function () {
        // Back off on errors: 3 s, 6 s, 12 s ... at most 60 s.
        failures += 1;
        message.textContent = 'Connection problem; still trying…';
        schedule(Math.min(60000, 3000 * Math.pow(2, failures - 1)));
      });
  }

  function join() {
    return handle(fetch('/queue/join', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: '{}',
    }));
  }

  function poll() {
    return handle(fetch('/queue/status', { credentials: 'same-origin', cache: 'no-store' }));
  }

  join();
})();
