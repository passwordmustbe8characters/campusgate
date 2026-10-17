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

  // Password reset: the token comes in the URL fragment (never sent to the server).
  // Copy it into the form, then remove it from the address bar and history.
  var tokenMatch = /[#&]token=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  document.querySelectorAll('form[data-token-from-hash]').forEach(function (form) {
    if (tokenMatch) form.querySelector('input[name="token"]').value = tokenMatch[1];
  });
  if (tokenMatch && window.history.replaceState) {
    window.history.replaceState(null, '', window.location.pathname);
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
          var body = result.body;
          if (result.ok) {
            // Sign-in flow: follow the status the server returns.
            if (body.status === 'second_factor_required') {
              window.location.assign('/verify?method=' + encodeURIComponent(body.method));
              return;
            }
            if (body.status === 'signed_in' || body.status === 'enrolment_required') {
              window.location.assign('/account/security');
              return;
            }
            var redirect = form.getAttribute('data-redirect');
            if (redirect) { window.location.assign(redirect); return; }
            if (form.hasAttribute('data-reload')) { window.location.reload(); return; }
            setText(message, body.message || 'Done.', 'ok');
            var tokenInput = form.querySelector('input[name="token"]');
            var keepToken = tokenInput && tokenInput.value;
            form.reset();
            if (keepToken) tokenInput.value = keepToken;
            // TOTP enrolment: show the QR code and manual key.
            var qr = form.querySelector('[data-qr]');
            if (qr && body.qrDataUrl) {
              qr.querySelector('img').src = body.qrDataUrl;
              qr.querySelector('[data-secret]').textContent = body.secret;
              qr.hidden = false;
            }
            // Backup codes: shown once.
            var list = form.querySelector('[data-backup-codes]');
            if (list && body.backupCodes) {
              list.textContent = '';
              body.backupCodes.forEach(function (code) {
                var li = document.createElement('li');
                li.textContent = code;
                list.appendChild(li);
              });
              list.hidden = false;
            }
            return;
          }
          if (body.restart) {
            setText(message, body.error, 'error');
            setTimeout(function () { window.location.assign('/login'); }, 1500);
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
