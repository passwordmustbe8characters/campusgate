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
})();
