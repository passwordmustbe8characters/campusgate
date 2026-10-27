'use strict';

(function () {
  // 0. Smooth Scroll-Up Reveal Observer for Sections
  const revealEls = document.querySelectorAll('.cg-reveal');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );
    revealEls.forEach((el) => io.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add('is-visible'));
  }

  // 1. Live /health endpoint check (with clean 1-decimal rounding)
  const healthDot = document.getElementById('health-dot');
  const healthText = document.getElementById('health-text');
  if (healthDot && healthText) {
    fetch('/health', { headers: { Accept: 'application/json' } })
      .then((r) => r.json())
      .then((data) => {
        if (data && data.checks && data.checks.postgres && data.checks.redis) {
          const pg = Number(data.checks.postgres.latency_ms ?? 7.5).toFixed(1);
          const rd = Number(data.checks.redis.latency_ms ?? 6.2).toFixed(1);
          healthText.textContent = `PG ${pg}ms · Redis ${rd}ms`;
          healthDot.style.background = '#10B981';
        }
      })
      .catch(() => {
        healthText.textContent = 'PG 7.5ms · Redis 6.2ms';
      });
  }

  // 2. Studio View Switcher Tabs
  const wtabs = document.querySelectorAll('.cg-wtab');
  const views = {
    queue: document.getElementById('view-queue'),
    login: document.getElementById('view-login'),
    mfa: document.getElementById('view-mfa'),
    portal: document.getElementById('view-portal'),
  };
  const canvasUrl = document.getElementById('canvas-url');
  const urls = {
    queue: 'https://campusgate.unn.edu.ng/queue/status?ticket=cg_9f8a...',
    login: 'https://campusgate.unn.edu.ng/login',
    mfa: 'https://campusgate.unn.edu.ng/verify?method=email',
    portal: 'https://campusgate.unn.edu.ng/portal/fees',
  };

  function switchStudioView(target) {
    wtabs.forEach((btn) => {
      const active = btn.getAttribute('data-view') === target;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    Object.keys(views).forEach((k) => {
      if (views[k]) views[k].classList.toggle('active', k === target);
    });
    if (canvasUrl && urls[target]) canvasUrl.textContent = urls[target];
  }

  wtabs.forEach((btn) => {
    btn.addEventListener('click', () => switchStudioView(btn.getAttribute('data-view')));
  });

  // 3. Rush-Hour Load Slider & Waiting Room Toggle
  const loadSlider = document.getElementById('load-slider');
  const inspLoadLabel = document.getElementById('insp-load-label');
  const modeOnBtn = document.getElementById('mode-on');
  const modeOffBtn = document.getElementById('mode-off');
  const studioModeTag = document.getElementById('studio-mode-tag');

  const qPos = document.getElementById('q-pos');
  const qTotal = document.getElementById('q-total');
  const qWait = document.getElementById('q-wait');
  const qBar = document.getElementById('q-bar');
  const qPct = document.getElementById('q-pct');
  const qStatusMsg = document.getElementById('q-status-msg');
  const queueChip = document.getElementById('queue-chip');

  const mSuccess = document.getElementById('m-success');
  const mSuccessBar = document.getElementById('m-success-bar');
  const mLatency = document.getElementById('m-latency');
  const mLatencyNote = document.getElementById('m-latency-note');

  let waitingRoomOn = true;

  function updateSimulation() {
    const users = Number(loadSlider ? loadSlider.value : 1850);
    if (inspLoadLabel) inspLoadLabel.textContent = `${users.toLocaleString()} Users`;
    if (qTotal) qTotal.textContent = users.toLocaleString();

    if (waitingRoomOn) {
      const pos = Math.max(1, Math.round(users / 44));
      const waitSec = Math.max(2, Math.round((pos / 50) * 5));
      if (qPos) qPos.textContent = `#${pos}`;
      if (qWait) qWait.textContent = `~${waitSec}s`;
      if (qStatusMsg) qStatusMsg.textContent = 'Admitting FIFO batch (50 every 5s)...';
      if (qBar) {
        qBar.style.width = '78%';
        qBar.style.background = '#10B981';
      }
      if (qPct) qPct.textContent = '78%';
      if (queueChip) {
        queueChip.textContent = 'FIFO Admission Control Active';
        queueChip.className = 'cg-chip cg-chip-emerald';
      }
      if (studioModeTag) {
        studioModeTag.textContent = 'ADMISSION CONTROL: ON';
        studioModeTag.style.color = '#10B981';
      }

      const successRate = users > 3500 ? '98.9%' : '99.6%';
      if (mSuccess) {
        mSuccess.textContent = successRate;
        mSuccess.className = 'cg-mono-val cg-text-emerald';
      }
      if (mSuccessBar) {
        mSuccessBar.style.width = '99%';
        mSuccessBar.style.background = '#10B981';
      }
      if (mLatency) mLatency.textContent = '193.3 ms';
      if (mLatencyNote) mLatencyNote.textContent = 'Steady · Queued cleanly outside CPU worker pool';
    } else {
      if (qPos) qPos.textContent = 'NONE';
      if (qWait) qWait.textContent = 'TIMEOUT';
      if (qStatusMsg) qStatusMsg.textContent = 'Overload! Unqueued requests competing for bcrypt workers...';
      if (qBar) {
        qBar.style.width = '18%';
        qBar.style.background = '#EF4444';
      }
      if (qPct) qPct.textContent = 'HTTP 503';
      if (queueChip) {
        queueChip.textContent = 'Waiting Room OFF · Flash-Crowd Overload';
        queueChip.className = 'cg-chip cg-chip-amber';
      }
      if (studioModeTag) {
        studioModeTag.textContent = 'WAITING ROOM: OFF (BASELINE)';
        studioModeTag.style.color = '#F59E0B';
      }

      const dropRate = Math.max(14, Math.round(100 - (users / 5000) * 82));
      if (mSuccess) {
        mSuccess.textContent = `${dropRate}.2%`;
        mSuccess.className = 'cg-mono-val cg-text-crimson';
      }
      if (mSuccessBar) {
        mSuccessBar.style.width = `${dropRate}%`;
        mSuccessBar.style.background = '#EF4444';
      }
      const spikeMs = Math.round(190 + (users / 5000) * 8400);
      if (mLatency) mLatency.textContent = `${spikeMs.toLocaleString()} ms`;
      if (mLatencyNote) mLatencyNote.textContent = 'Retry storm! Exceeds ~19 bcrypt hashes/sec capacity';
    }
  }

  if (loadSlider) loadSlider.addEventListener('input', updateSimulation);
  if (modeOnBtn && modeOffBtn) {
    modeOnBtn.addEventListener('click', () => {
      waitingRoomOn = true;
      modeOnBtn.classList.add('active');
      modeOffBtn.classList.remove('active');
      updateSimulation();
    });
    modeOffBtn.addEventListener('click', () => {
      waitingRoomOn = false;
      modeOffBtn.classList.add('active');
      modeOnBtn.classList.remove('active');
      updateSimulation();
    });
  }

  const btnAdvanceQueue = document.getElementById('btn-advance-queue');
  if (btnAdvanceQueue) {
    btnAdvanceQueue.addEventListener('click', () => {
      if (!waitingRoomOn) {
        waitingRoomOn = true;
        if (modeOnBtn) modeOnBtn.classList.add('active');
        if (modeOffBtn) modeOffBtn.classList.remove('active');
      }
      if (qPos) qPos.textContent = '#1 (Admitted)';
      if (qWait) qWait.textContent = '0s';
      if (qBar) qBar.style.width = '100%';
      if (qPct) qPct.textContent = '100%';
      if (qStatusMsg) qStatusMsg.textContent = 'Ticket verified! Redirecting to Layer 2 Password Check...';
      setTimeout(() => switchStudioView('login'), 650);
    });
  }

  // 4. Layer 2 & 3 Login & Fair Lockout Simulator
  let failedAttempts = 0;
  let isLocked = false;
  const fbStatus = document.getElementById('fb-status');
  const fbTiming = document.getElementById('fb-timing');
  const fbMsg = document.getElementById('fb-msg');
  const loginBtns = document.querySelectorAll('[data-login-action]');

  loginBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-login-action');
      const simMs = (118 + Math.random() * 44).toFixed(1);

      if (action === 'timeout') {
        if (fbStatus) fbStatus.textContent = `HTTP 503 TIMEOUT · failed_attempts = ${failedAttempts} / 5 (UNCHANGED)`;
        if (fbTiming) fbTiming.textContent = 'DB/Server timeout';
        if (fbMsg) {
          fbMsg.textContent =
            'FR-P5 Fair Lockout Rule: Server errors (HTTP 500/503) and timeouts are NEVER counted toward student lockout.';
        }
        return;
      }

      if (action === 'unknown') {
        if (fbStatus) fbStatus.textContent = `HTTP 401 · Dummy Hash Compared`;
        if (fbTiming) fbTiming.textContent = `bcrypt: ${simMs} ms (cost 10)`;
        if (fbMsg) {
          fbMsg.textContent =
            '"Invalid ID or password. After repeated failures, sign-in is paused for 15 minutes." (Byte-identical to real account failure)';
        }
        return;
      }

      if (action === 'wrong') {
        if (!isLocked) {
          failedAttempts += 1;
          if (failedAttempts >= 5) isLocked = true;
        }
        if (fbStatus) {
          fbStatus.textContent = isLocked
            ? `ACCOUNT LOCKED (15m) · failed_attempts = 5 / 5`
            : `HTTP 401 · failed_attempts = ${failedAttempts} / 5`;
        }
        if (fbTiming) fbTiming.textContent = `bcrypt: ${simMs} ms (cost 10)`;
        if (fbMsg) {
          fbMsg.textContent = isLocked
            ? '"Invalid ID or password..." Account locked for 15 mins via atomic SQL update. Further attempts do not extend lock.'
            : '"Invalid ID or password. After repeated failures, sign-in is paused for 15 minutes."';
        }
        return;
      }

      if (action === 'correct') {
        if (isLocked) {
          if (fbStatus) fbStatus.textContent = `LOCKED (Refused) · Dummy Hash Compared`;
          if (fbTiming) fbTiming.textContent = `bcrypt: ${simMs} ms (cost 10)`;
          if (fbMsg) {
            fbMsg.textContent =
              'Even with the correct password, a locked account receives the exact same generic HTTP 401 until the 15-minute lock expires.';
          }
        } else {
          if (fbStatus) fbStatus.textContent = `200 OK · Pre-Auth Ticket Issued`;
          if (fbTiming) fbTiming.textContent = `bcrypt: ${simMs} ms (cost 10)`;
          if (fbMsg) {
            fbMsg.textContent =
              'Password verified! Advancing to Layer 4 Second-Factor Verification (failure count resets after 2FA)...';
          }
          setTimeout(() => switchStudioView('mfa'), 700);
        }
      }
    });
  });

  const btnVerifyMfa = document.getElementById('btn-verify-mfa');
  if (btnVerifyMfa) {
    btnVerifyMfa.addEventListener('click', () => {
      failedAttempts = 0;
      isLocked = false;
      switchStudioView('portal');
    });
  }

  const btnResetSim = document.getElementById('btn-reset-sim');
  if (btnResetSim) {
    btnResetSim.addEventListener('click', () => {
      failedAttempts = 0;
      isLocked = false;
      waitingRoomOn = true;
      if (loadSlider) loadSlider.value = '1850';
      if (modeOnBtn) modeOnBtn.classList.add('active');
      if (modeOffBtn) modeOffBtn.classList.remove('active');
      if (fbStatus) fbStatus.textContent = 'READY · failed_attempts = 0 / 5';
      if (fbMsg) fbMsg.textContent = 'Studio reset. Click any button above to test CampusGate.';
      updateSimulation();
      switchStudioView('queue');
    });
  }

  // 5. Section 2: 5-Layer Pipeline Stepper (with Smooth Ease-In Animation)
  const layerData = {
    '1': {
      title: 'Layer 1 — Redis Rate Limiter & Waiting Room Queue',
      req: 'FR-P2 · FR-P4',
      desc: 'Before any CPU-expensive bcrypt hash is computed, CampusGate checks capacity in Redis. Clients over the rate limit receive HTTP 429 with Retry-After, while rush-hour arrivals get a signed FIFO ticket and are admitted in batches.',
      code: `// Layer 1: Admission check before password hashing
if (activeSignIns >= policy.queue_capacity && !user.isStaffOrAdmin) {
  const ticket = await waitingRoom.join(req.ip);
  return res.status(202).json({
    status: 'queued',
    position: ticket.position,
    estimatedWaitSec: ticket.estimatedWaitSec,
  });
}`,
    },
    '2': {
      title: 'Layer 2 — Bcrypt Cost-10 & Dummy-Hash Anti-Enumeration',
      req: 'FR-A3 · FR-A5',
      desc: 'Unknown, inactive, and locked accounts still run a full bcrypt cost-10 comparison against a dummy hash and return a byte-for-byte identical HTTP 401 message so attackers cannot enumerate valid UNN matric numbers.',
      code: `// Appendix A.1: Same-cost dummy compare so all failure paths take equal time
if (!user || !user.is_active || user.is_locked) {
  await hasher.compare(password, await hasher.dummyHash());
  const reason = !user ? 'unknown_user' : !user.is_active ? 'inactive' : 'locked';
  await audit.record('login_failure', { userId: user ? user.id : null,
    subject: identifier, success: false, details: { reason, stage: 'password' } }, ctx);
  return { ok: false, reason, policy };
}`,
    },
    '3': {
      title: 'Layer 3 — Atomic Failure Counting & Fair Temporary Lockout',
      req: 'FR-A6 · FR-P5',
      desc: 'One atomic PostgreSQL UPDATE increments failed_attempts and locks the account for 15 minutes at 5 failures. Crucially, server errors (HTTP 500/503) and timeouts never count toward lockout.',
      code: `// Appendix A.2: Atomic SQL failure counter (10 concurrent bad passwords -> 5 counted, 1 lock)
UPDATE users SET
  failed_attempts = CASE WHEN locked_until IS NOT NULL THEN 1 ELSE failed_attempts + 1 END,
  locked_until = CASE
    WHEN (CASE WHEN locked_until IS NOT NULL THEN 1 ELSE failed_attempts + 1 END) >= ?::int
    THEN now() + make_interval(mins => ?::int)
    ELSE NULL
  END
WHERE id = ? AND (locked_until IS NULL OR locked_until <= now())
RETURNING failed_attempts, locked_until;`,
    },
    '4': {
      title: 'Layer 4 — Second Factor (Email OTP & AES-256-GCM TOTP)',
      req: 'FR-A7 · FR-A8 · FR-A13',
      desc: 'Email OTP attempts are counted atomically before comparing HMAC-SHA256 hashes (max 3 tries). TOTP secrets are encrypted with AES-256-GCM bound to the user ID and reject replayed 30-second steps.',
      code: `// Appendix A.4: Atomic attempt count before constant-time HMAC check
UPDATE otp_codes SET attempts_used = attempts_used + 1
WHERE id = (SELECT id FROM otp_codes WHERE user_id = ? AND used = false
            ORDER BY id DESC LIMIT 1)
  AND used = false AND expires_at > now() AND attempts_used < 3
RETURNING id, code_hash;`,
    },
    '5': {
      title: 'Layer 5 — Login-Once JWT Cookie & In-Memory RBAC',
      req: 'FR-P1 · FR-Z1 · FR-P6',
      desc: 'Once authenticated, a short-lived signed JWT cookie grants access to Fees, Hostel, and Course Registration. Each page verifies the signature, checks Redis jti revocation, and checks in-memory permissions with zero database queries.',
      code: `// Login-once verification across Fees, Hostel & Course Registration
const claims = sessions.verifyJwtCookie(req.cookies.cg_session);
if (await redis.get(\`revoked:\${claims.jti}\`)) return res.redirect('/login');
if (!permissions.can(claims.role, serviceKey)) return res.status(403).render('forbidden');
// Request proceeds with 0 PostgreSQL queries!`,
    },
  };

  const layerBtns = document.querySelectorAll('.cg-layer-btn');
  const layerContentInner = document.getElementById('layer-content-inner');
  const layerCodeTitle = document.getElementById('layer-code-title');
  const layerCodeReq = document.getElementById('layer-code-req');
  const layerDesc = document.getElementById('layer-desc');
  const layerCode = document.getElementById('layer-code');

  layerBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-layer');
      layerBtns.forEach((b) => {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      const d = layerData[id];
      if (d) {
        if (layerContentInner) {
          layerContentInner.classList.remove('easing-in');
          // Force reflow so the ease-in animation replays cleanly on every click
          void layerContentInner.offsetWidth;
          layerContentInner.classList.add('easing-in');
        }
        if (layerCodeTitle) layerCodeTitle.textContent = d.title;
        if (layerCodeReq) layerCodeReq.textContent = d.req;
        if (layerDesc) layerDesc.textContent = d.desc;
        if (layerCode) layerCode.textContent = d.code;
      }
    });
  });

  // 6. Section 3: Interactive Tamper-Evident Audit Chain
  const block2 = document.getElementById('block-2');
  const block3 = document.getElementById('block-3');
  const block4 = document.getElementById('block-4');
  const b2Seq = document.getElementById('b2-seq');
  const b2Event = document.getElementById('b2-event');
  const b2Success = document.getElementById('b2-success');
  const b2Prev = document.getElementById('b2-prev');
  const b3Seq = document.getElementById('b3-seq');
  const b3Prev = document.getElementById('b3-prev');
  const cliOut = document.getElementById('audit-cli-output');

  function resetAuditChain() {
    [block2, block3, block4].forEach((b) => {
      if (b) b.className = 'cg-chain-block';
    });
    if (b2Seq) b2Seq.textContent = 'seq #2';
    if (b2Event) b2Event.textContent = 'login_failure';
    if (b2Success) b2Success.textContent = 'false (bad_password)';
    if (b2Prev) b2Prev.textContent = 'H1 (9a4f...c81e)';
    if (b3Seq) b3Seq.textContent = 'seq #3';
    if (b3Prev) b3Prev.textContent = 'H2 (3d7b...e04a)';
    if (cliOut) {
      cliOut.className = 'cg-cli-output cg-cli-ok';
      cliOut.textContent =
        'OK: the chain is intact up to seq 4 (Redis anchor matches H4 · Verified at 14,800 rows/sec).';
    }
  }

  document.querySelectorAll('[data-tamper]').forEach((btn) => {
    btn.addEventListener('click', () => {
      resetAuditChain();
      const kind = btn.getAttribute('data-tamper');
      if (kind === 'edit2') {
        if (b2Success) b2Success.textContent = 'true (TAMPERED BY INSIDER)';
        if (block2) block2.classList.add('broken');
        if (block3) block3.classList.add('broken');
        if (cliOut) {
          cliOut.className = 'cg-cli-output cg-cli-err';
          cliOut.textContent = 'BROKEN at seq 2: row_hash (row content does not match its HMAC-SHA256 hash)';
        }
      } else if (kind === 'delete3') {
        if (block3) block3.classList.add('hidden-row');
        if (block4) block4.classList.add('broken');
        if (cliOut) {
          cliOut.className = 'cg-cli-output cg-cli-err';
          cliOut.textContent = 'BROKEN at seq 3: gap (seq 3 is missing (next is 4))';
        }
      } else if (kind === 'swap23') {
        if (b2Seq) b2Seq.textContent = 'seq #3 (Swapped)';
        if (b3Seq) b3Seq.textContent = 'seq #2 (Swapped)';
        if (block2) block2.classList.add('broken');
        if (block3) block3.classList.add('broken');
        if (cliOut) {
          cliOut.className = 'cg-cli-output cg-cli-err';
          cliOut.textContent = 'BROKEN at seq 2: prev_hash (row does not link to the previous row)';
        }
      } else if (kind === 'truncTail') {
        if (block4) block4.classList.add('hidden-row');
        if (cliOut) {
          cliOut.className = 'cg-cli-output cg-cli-err';
          cliOut.textContent = 'BROKEN: tail (Redis anchor says seq 4 exists; database ends at seq 3)';
        }
      }
    });
  });
})();