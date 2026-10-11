// Submits [data-api] forms as JSON with the CSRF token header.
// TODO(Phase 5): exponential backoff on 429/503 using Retry-After (FR-P4).
(function () {
  'use strict';

  var csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');

  function setText(el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.className = el.className.replace(/\bmsg-(ok|error)\b/g, '').trim();
    if (kind) el.className += ' msg-' + kind;
  }

  function formToJson(form) {
    var data = {};
    new FormData(form).forEach(function (value, key) { data[key] = value; });
    form.querySelectorAll('input[type="checkbox"]').forEach(function (box) {
      data[box.name] = box.checked;
    });
    return data;
  }

  document.querySelectorAll('form[data-api]').forEach(function (form) {
    var button = form.querySelector('button[type="submit"]');
    var message = form.querySelector('[data-message]');

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      form.querySelectorAll('[data-error-for]').forEach(function (el) { el.textContent = ''; });
      setText(message, '');
      button.disabled = true;

      fetch(form.getAttribute('data-api'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(formToJson(form)),
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            return { ok: res.ok, status: res.status, body: body };
          });
        })
        .then(function (result) {
          if (result.ok) {
            var redirect = form.getAttribute('data-redirect');
            if (redirect) { window.location.assign(redirect); return; }
            setText(message, result.body.message || 'Done.', 'ok');
            form.reset();
            return;
          }
          var fields = result.body.fields || {};
          Object.keys(fields).forEach(function (name) {
            var el = form.querySelector('[data-error-for="' + name + '"]');
            if (el) el.textContent = fields[name].join(' ');
          });
          if (result.status === 403) {
            setText(message, 'Your session expired. Reload the page and try again.', 'error');
          } else {
            setText(message, result.body.error || 'Something went wrong. Please try again.', 'error');
          }
        })
        .catch(function () {
          setText(message, 'Network problem. Check your connection and try again.', 'error');
        })
        .then(function () { button.disabled = false; });
    });
  });
})();
