// Admin dashboard (FR-D1): live figures over server-sent events.
(function () {
  'use strict';

  var status = document.querySelector('[data-dash-status]');
  var source = new EventSource('/admin/metrics/stream');

  source.onmessage = function (event) {
    var data = JSON.parse(event.data);
    Object.keys(data).forEach(function (name) {
      var cell = document.querySelector('[data-metric="' + name + '"]');
      if (cell) cell.textContent = data[name] === null ? '–' : String(data[name]);
    });
    status.textContent = 'Last update: ' + new Date(data.at).toLocaleTimeString();
  };
  source.addEventListener('unavailable', function () {
    status.textContent = 'Figures are temporarily unavailable.';
  });
  source.onerror = function () {
    status.textContent = 'Connection lost; reconnecting…'; // EventSource reconnects by itself
  };

  // Rush-hour simulation status (FR-P8).
  var sim = document.querySelector('[data-sim-status]');
  function showSim() {
    fetch('/admin/simulate/status', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (!s || s.state === 'idle') { sim.textContent = ''; return; }
        if (s.state === 'running') { sim.textContent = 'Simulation running: ' + s.users + ' students arriving over ' + s.rampSec + ' s…'; return; }
        if (s.state === 'failed') { sim.textContent = 'The last simulation failed to finish.'; return; }
        var m = s.summary;
        sim.textContent = 'Last simulation: ' + m.users + ' students, ' + m.succeeded + ' signed in (' + m.successRatePct + '%), ' +
          'average ' + (m.signInMeanMs / 1000).toFixed(1) + ' s, 95% within ' + (m.signInP95Ms / 1000).toFixed(1) + ' s, ' +
          m.timeouts + ' timeouts, ' + m.queuedStudents + ' waited in the queue.';
      })
      .catch(function () {});
  }
  showSim();
  setInterval(showSim, 3000);
})();
