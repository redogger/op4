/* ═══════════════════════════════════════════════════════════════════════════
 *  DULMS Watcher v15 — Main Entry Point
 *  ═══════════════════════════════════════════════════════════════════════════
 *  - HTTP-only (no browser)
 *  - Dynamic intervals (configurable via Telegram)
 *  - Persistent alerts (ring until /stop)
 *  - Session resilience (auto relogin)
 *  - Alert deduplication
 *  - First-scan silent
 * ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const {
  VERSION,
  log,
  audit,
  loadState,
  saveState,
  sleep,
  formatDuration,
  withTimeout,
} = require('./lib/core');

const {
  createClient,
  login,
  validateSession,
} = require('./lib/http');

const { makeApi }                          = require('./lib/api');
const { runCourseWatch,
        runGroupWatch,
        runScheduleWatch,
        runSecurityGuard }                 = require('./lib/watchers');

const { tgSend,
        registerBotCommands,
        pollTelegram,
        repeatActiveAlerts,
        MAIN_KEYBOARD }                    = require('./lib/telegram');

// ═══════════════════════════════════════════════════════════════════════════
//  USER CONFIG
// ═══════════════════════════════════════════════════════════════════════════
const USER_CONFIG = {
  targets: [
    { code: 'GEN 101', label: 'English 2' },
  ],

  // Default intervals (modifiable from Telegram)
  defaultIntervals: {
    groups:   5_000,      // GEN 101 check every 5 seconds
    courses:  300_000,    // All courses every 5 minutes
    schedule: 300_000,    // Registered courses schedule every 5 minutes
  },

  // Timing constants
  timing: {
    telegramPollMs:     3_000,
    heartbeatMs:        500,
    stateFlushMs:       30_000,
    memoryCheckMs:      60_000,
    persistentAlertsMs: 20_000,
  },

  session: {
    maxAgeMs:  25 * 60 * 1000,
    warnAgeMs: 15 * 60 * 1000,
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  const username = process.env.DULMS_USERNAME || '';
  const password = process.env.DULMS_PASSWORD || '';

  if (!username || !password) {
    log.err('Missing DULMS_USERNAME / DULMS_PASSWORD');
    process.exit(1);
  }

  log.info(`${VERSION} — PID ${process.pid}, RSS ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`);

  const durationMin = parseFloat(process.env.DURATION_MIN || '55');
  const deadline = Date.now() + durationMin * 60_000;
  log.info(`Duration: ${durationMin}min | Deadline: ${new Date(deadline).toISOString().slice(11, 19)} UTC`);

  // ─── Register Telegram commands ─────────────────────────
  await registerBotCommands();

  // ─── Load state ─────────────────────────────────────────
  let state = loadState();
  state.startedAt = Date.now();

  if (state.paused) {
    log.warn('Auto-resume');
    state.paused = false;
  }

  // Ensure intervals exist
  state.intervals = state.intervals || { ...USER_CONFIG.defaultIntervals };

  // ─── Create HTTP client + login ─────────────────────────
  const { client } = createClient();

  try {
    await login(client, { username, password });
    state.sessionStats.logins++;
    state.sessionStats.lastLoginAt = Date.now();
    saveState(state);
  } catch (e) {
    log.err(`Login failed: ${e.message}`);
    state.counters.errors++;
    state.lastError = {
      t: Date.now(),
      phase: 'initial_login',
      message: String(e.message).slice(0, 200),
    };
    saveState(state);
    await tgSend(
      `💥 <b>Initial login failed</b>\n\n<code>${e.message.slice(0, 200)}</code>`,
      { silent: false }
    );
    process.exit(1);
  }

  const api = makeApi(client);

  // ─── Startup brief ──────────────────────────────────────
  const startupGap = 12 * 60 * 60_000;
  if (Date.now() - state.startupBriefedAt > startupGap) {
    state.startupBriefedAt = Date.now();

    const targetList = USER_CONFIG.targets.map(t => t.code).join(', ');
    await tgSend(
      `🚀 <b>Watcher ${VERSION}</b>\n\n` +
      `🎯 Targets: <b>${targetList}</b>\n` +
      `⏱️ Groups interval: <b>${state.intervals.groups / 1000}s</b>\n` +
      `📅 Courses interval: <b>${state.intervals.courses / 1000}s</b>\n` +
      `🛡️ Guarding <b>${state.registeredCourses.length}</b> courses\n\n` +
      `📋 /help للأوامر`,
      { replyMarkup: MAIN_KEYBOARD }
    );
    saveState(state);
  }

  log.step(`${VERSION} STARTED`);

  // ═════════════════════════════════════════════════════════════════════
  //  MAIN LOOP — Dynamic Timers
  // ═════════════════════════════════════════════════════════════════════
  const T = USER_CONFIG.timing;

  const timers = {
    courseWatch:      Date.now() + 1_000,
    groupWatch:       Date.now() + 3_000,
    scheduleWatch:    Date.now() + 10_000,
    securityGuard:    Date.now() + 5_000,
    telegram:         Date.now() + 1_000,
    persistentAlerts: Date.now() + T.persistentAlertsMs,
    stateFlush:       Date.now() + T.stateFlushMs,
    memory:           Date.now() + T.memoryCheckMs,
  };

  let sessionExpired = false;
  let consecutiveErrors = 0;

  while (Date.now() < deadline) {
    const now = Date.now();

    // ─── 1. Telegram polling ───────────────────────────────
    if (now >= timers.telegram) {
      try {
        await pollTelegram(state, api);
      } catch (e) {
        log.warn(`TG poll error: ${e.message}`);
      }
      timers.telegram = Date.now() + T.telegramPollMs;
    }

    // ─── 2. Pause check ────────────────────────────────────
    if (state.paused) {
      await sleep(1_000);
      continue;
    }

    // ─── 3. State flush ────────────────────────────────────
    if (now >= timers.stateFlush) {
      saveState(state);
      timers.stateFlush = Date.now() + T.stateFlushMs;
    }

    // ─── 4. Persistent alerts ──────────────────────────────
    if (now >= timers.persistentAlerts) {
      try {
        await repeatActiveAlerts(state);
      } catch (e) {
        log.warn(`Persistent alert error: ${e.message}`);
      }
      timers.persistentAlerts = Date.now() + T.persistentAlertsMs;
    }

    // ─── 5. Memory check ───────────────────────────────────
    if (now >= timers.memory) {
      const mb = Math.round(process.memoryUsage().rss / 1024 / 1024);
      if (mb >= 900) {
        log.err(`Memory critical (${mb} MB) — exiting`);
        saveState(state);
        process.exit(1);
      } else if (mb >= 700) {
        log.warn(`Memory high: ${mb} MB`);
      }
      timers.memory = Date.now() + T.memoryCheckMs;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  WATCHERS — with dynamic intervals
    // ═══════════════════════════════════════════════════════════════════

    // ─── Course Watch (dynamic interval) ───────────────────
    if (now >= timers.courseWatch) {
      try {
        await runCourseWatch(api, state, USER_CONFIG.targets);
        consecutiveErrors = 0;
      } catch (e) {
        log.warn(`CourseWatch error: ${e.message}`);
        consecutiveErrors++;
      }
      timers.courseWatch = Date.now() + state.intervals.courses;
    }

    // ─── Group Watch (dynamic interval — default 5s) ───────
    if (now >= timers.groupWatch) {
      try {
        const r = await runGroupWatch(api, state);
        consecutiveErrors = 0;

        if (r && r.kind === 'session_dead') {
          log.warn('GroupWatch: session dead — relogin');
          sessionExpired = true;
        }
      } catch (e) {
        log.warn(`GroupWatch error: ${e.message}`);
        consecutiveErrors++;
      }
      timers.groupWatch = Date.now() + state.intervals.groups;
    }

    // ─── Schedule Watch (dynamic interval — default 5min) ──
    if (now >= timers.scheduleWatch) {
      try {
        const r = await runScheduleWatch(api, state);
        if (r && r.kind === 'session_dead') {
          sessionExpired = true;
        }
      } catch (e) {
        log.warn(`ScheduleWatch error: ${e.message}`);
      }
      timers.scheduleWatch = Date.now() + state.intervals.schedule;
    }

    // ─── Security Guard (fixed interval — 10 min) ──────────
    if (now >= timers.securityGuard) {
      try {
        const r = await runSecurityGuard(api, state);
        if (r && r.kind === 'session_dead') {
          sessionExpired = true;
        }
      } catch (e) {
        log.warn(`SecurityGuard error: ${e.message}`);
      }
      timers.securityGuard = Date.now() + 10 * 60_000;
    }

    // ─── Session dead handling ─────────────────────────────
    if (sessionExpired) {
      sessionExpired = false;
      state.counters.relogins++;
      state.sessionStats.relogins++;
      log.sess('Session dead — re-login');

      try {
        await login(client, { username, password });
        state.sessionStats.logins++;
        state.sessionStats.lastLoginAt = Date.now();
        consecutiveErrors = 0;
        saveState(state);
      } catch (e) {
        log.err(`Relogin failed: ${e.message}`);
        state.counters.errors++;
        state.sessionStats.failures++;
        await sleep(60_000);  // wait 1 min before next loop iteration
      }
    }

    // ─── Too many consecutive errors → slow down ───────────
    if (consecutiveErrors >= 5) {
      log.warn(`Too many errors (${consecutiveErrors}) — slowing down`);
      state.intervals.groups = Math.max(state.intervals.groups, 60_000);
      consecutiveErrors = 0;
    }

    await sleep(T.heartbeatMs);
  }

  // ═════════════════════════════════════════════════════════════════════
  //  SHUTDOWN
  // ═════════════════════════════════════════════════════════════════════
  saveState(state);
  log.info(`Exiting — RSS ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`);
  process.exit(0);
})();
