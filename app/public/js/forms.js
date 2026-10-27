// Submits [data-api] forms as JSON with the CSRF token header.
// On 429/503 it waits (Retry-After, doubling each time) and retries (FR-P4);
// a { queued: true } reply sends the user to the waiting room (FR-P2).
(function () {
  'use strict';

  var MAX_RETRIES = 3;

  // Retry-After seconds if given (else 2 s), doubled per retry, at most 60 s.
  function backoffMs(retryAfter, retries) {
    var base = Number(retryAfter) > 0 ? Number(retryAfter) * 1000 : 2000;
    return Math.min(60000, base * Math.pow(2, retries));
  }

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
      send(0);
    });

    function send(retries) {
      fetch(form.getAttribute('data-api'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(formToJson(form)),
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            return { ok: res.ok, status: res.status, body: body, retryAfter: res.headers.get('Retry-After') };
          });
        })
        .then(function (result) {
          var body = result.body;
          // Waiting room (FR-P2): take a place in the queue.
          if (body.queued) {
            window.location.assign(body.redirect || '/waiting');
            return 'leaving';
          }
          // Busy or rate limited (FR-P4): wait as the server asks, then try again with backoff.
          if ((result.status === 429 || result.status === 503) && retries < MAX_RETRIES) {
            var wait = backoffMs(result.retryAfter, retries);
            setText(message, (body.error || 'The system is busy.') + ' Trying again in ' + Math.ceil(wait / 1000) + ' s…', 'error');
            setTimeout(function () { send(retries + 1); }, wait);
            return 'retrying';
          }
          if (result.ok) {
            // Sign-in flow: follow the status the server returns.
            if (body.status === 'second_factor_required') {
              window.location.assign('/verify?method=' + encodeURIComponent(body.method));
              return;
            }
            if (body.status === 'signed_in') {
              window.location.assign('/home');
              return;
            }
            if (body.status === 'enrolment_required') {
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
        .then(function (state) { if (state !== 'retrying' && state !== 'leaving') button.disabled = false; });
    }
  });
})();

document.addEventListener('DOMContentLoaded', () => {
  // 1. Password Visibility Eye Toggle
  document.querySelectorAll('.pw-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = btn.previousElementSibling;
      const svg = btn.querySelector('svg');
      if (input && input.type === 'password') {
        input.type = 'text';
        // Change to "Eye Off" (slashed) icon
        svg.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>';
      } else if (input) {
        input.type = 'password';
        // Change back to "Eye Open" icon
        svg.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
      }
    });
  });

  // 2. Real-Time Green Password Validation
  const pwInput = document.getElementById('password');
  const rulesList = document.getElementById('pw-rules');
  
  if (pwInput && rulesList) {
    const ruleItems = rulesList.querySelectorAll('li');
    
    // Automatically find what min_length the Node backend set (e.g. "Use at least 8 characters")
    let minLength = 8; 
    ruleItems.forEach(li => {
      const match = li.textContent.match(/at least (\d+) characters/);
      if (match) minLength = parseInt(match[1], 10);
    });

    pwInput.addEventListener('input', (e) => {
      const val = e.target.value;
      
      ruleItems.forEach(li => {
        const text = li.textContent.toLowerCase();
        let passed = false;
        
        if (text.includes('characters')) {
          passed = val.length >= minLength;
        } else if (text.includes('uppercase')) {
          passed = /[A-Z]/.test(val);
        } else if (text.includes('special')) {
          passed = /[^a-zA-Z0-9]/.test(val);
        } else if (text.includes('common')) {
          // Blocklist checks happen on the server; we leave this neutral until submit
          return; 
        }
        
        if (passed) {
          li.classList.add('passed');
        } else {
          li.classList.remove('passed');
        }
      });
    });
  }
});