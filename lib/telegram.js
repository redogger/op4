/* ═══════════════════════════════════════════════════════════════════════════
 *  DULMS Watcher v15 — Telegram Integration
 *  ═══════════════════════════════════════════════════════════════════════════
 *  - Sender (queue + rate limit + retries)
 *  - Command handlers
 *  - Keyboards
 *  - Persistent alerts
 * ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const {
  log,
  sleep,
  escapeHtml,
  truncate,
  formatDuration,
  timeSince,
  statusLabel,
  normalizeCode,
  shouldSendAlert,
} = require('./core');

// ═══════════════════════════════════════════════════════════════════════════
//  TELEGRAM QUEUE
// ═══════════════════════════════════════════════════════════════════════════
const tgQueue      = [];
const tgTimestamps = [];
let   tgSending    = false;
const MAX_PER_MIN  = 20;

function pruneRateLimit(now) {
  while (tgTimestamps.length && now - tgTimestamps[0] > 60_000) {
    tgTimestamps.shift();
  }
}

async function waitForRateLimit() {
  const now = Date.now();
  pruneRateLimit(now);
  if (tgTimestamps.length >= MAX_PER_MIN) {
    const waitMs = 60_000 - (now - tgTimestamps[0]) + 100;
    log.tg(`Rate limit — waiting ${formatDuration(waitMs)}`);
    await sleep(waitMs);
    pruneRateLimit(Date.now());
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SENDER
// ═══════════════════════════════════════════════════════════════════════════
async function tgSend(html, { silent = false, replyMarkup = null } = {}) {
  const token  = process.env.TG_TOKEN;
  const chatId = process.env.TG_CHAT_ID;

  if (!token || !chatId || !html) return;

  tgQueue.push({
    html:        truncate(html),
    silent,
    replyMarkup,
  });

  if (tgSending) return;
  tgSending = true;

  try {
    while (tgQueue.length > 0) {
      await waitForRateLimit();
      tgTimestamps.push(Date.now());

      const { html: msg, silent: sil, replyMarkup: rm } = tgQueue.shift();

      const payload = {
        chat_id:                  chatId,
        text:                     msg,
        parse_mode:               'HTML',
        disable_web_page_preview: true,
        disable_notification:     sil,
      };
      if (rm) payload.reply_markup = rm;

      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(payload),
        });
        const body = await res.json().catch(() => ({}));

        if (!body.ok) {
          if (body.error_code === 429) {
            const retryAfter = (body.parameters && body.parameters.retry_after) || 5;
            tgQueue.unshift({ html: msg, silent: sil, replyMarkup: rm });
            log.tg(`Rate limited — waiting ${retryAfter}s`);
            await sleep(retryAfter * 1000);
          } else {
            log.warn(`TG rejected (${body.error_code || '?'}): ${body.description || 'unknown'}`);
          }
        }
      } catch (e) {
        log.warn('TG send failed:', e.message);
      }

      await sleep(1_100);
    }
  } finally {
    tgSending = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  KEYBOARDS
// ═══════════════════════════════════════════════════════════════════════════
const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '📊 Status' }, { text: '🎯 Groups' }],
    [{ text: '🔥 Open' },   { text: '📅 Schedule' }],
    [{ text: '⏱️ Interval' }, { text: '🔔 Alerts' }],
    [{ text: '⏸️ Pause' },  { text: '▶️ Resume' }],
    [{ text: '🔄 Reset' },  { text: '❓ Help' }],
  ],
  resize_keyboard: true,
  is_persistent:   true,
};

const BUTTON_MAP = {
  '📊 Status':    '/status',
  '🎯 Groups':    '/groups',
  '🔥 Open':      '/open',
  '📅 Schedule':  '/schedule',
  '⏱️ Interval':  '/interval',
  '🔔 Alerts':    '/alerts',
  '⏸️ Pause':     '/pause',
  '▶️ Resume':    '/resume',
  '🔄 Reset':     '/reset',
  '❓ Help':      '/help',
};

const BOT_COMMANDS = [
  { command: 'start',    description: '🟢 Bot alive' },
  { command: 'status',   description: '📊 Status report' },
  { command: 'groups',   description: '🎯 GEN101 groups' },
  { command: 'open',     description: '🔥 Open groups' },
  { command: 'schedule', description: '📅 Registered schedule' },
  { command: 'interval', description: '⏱️ Change intervals' },
  { command: 'alerts',   description: '🔔 Active alerts' },
  { command: 'stop',     description: '🔕 Stop all alerts' },
  { command: 'diag',     description: '🩺 Diagnostic' },
  { command: 'audit',    description: '📜 Last 10 events' },
  { command: 'pause',    description: '⏸️ Pause' },
  { command: 'resume',   description: '▶️ Resume' },
  { command: 'reset',    description: '🔄 Reset' },
  { command: 'help',     description: '❓ Commands' },
];

// ═══════════════════════════════════════════════════════════════════════════
//  REGISTER COMMANDS
// ═══════════════════════════════════════════════════════════════════════════
async function registerBotCommands() {
  const token  = process.env.TG_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const chatIdNum = Number(chatId);
    const scope = Number.isFinite(chatIdNum)
      ? { type: 'chat', chat_id: chatIdNum }
      : { type: 'default' };

    await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ commands: BOT_COMMANDS, scope }),
    });

    log.ok(`Registered ${BOT_COMMANDS.length} commands`);
  } catch (e) {
    log.warn('Command registration failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  POLLING
// ═══════════════════════════════════════════════════════════════════════════
async function pollTelegram(state, api) {
  const token  = process.env.TG_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  if (!token) return;

  try {
    const offset = state.lastTgUpdateId ? state.lastTgUpdateId + 1 : -1;
    const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=0`;

    const res  = await fetch(url);
    const data = await res.json();

    if (!data.ok || !Array.isArray(data.result)) return;

    for (const upd of data.result) {
      state.lastTgUpdateId = Math.max(state.lastTgUpdateId || 0, upd.update_id);

      const msg = upd.message;
      if (!msg?.text) continue;
      if (String(msg.chat.id) !== chatId) continue;

      const text = msg.text.trim();
      let cmd, args;

      if (BUTTON_MAP[text]) {
        cmd  = BUTTON_MAP[text];
        args = [];
      } else {
        const parts = text.split(/\s+/);
        cmd  = parts[0].toLowerCase().replace(/@\w+$/, '');
        args = parts.slice(1);
      }

      await handleCommand(cmd, args, state, api);
    }
  } catch (e) {
    log.warn('TG poll failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  COMMAND HANDLER
// ═══════════════════════════════════════════════════════════════════════════
async function handleCommand(cmd, args, state, api) {
  const activeCode = Object.keys(state.targets)[0] || 'GEN 101';
  const activeTgt  = state.targets[activeCode] || {};

  switch (cmd) {
    case '/start':
      await tgSend(`🎛️ <b>DULMS Watcher v15</b>`, { replyMarkup: MAIN_KEYBOARD });
      await handleCommand('/status', [], state, api);
      break;

    case '/status': {
      const uptimeMin = Math.floor((Date.now() - (state.startedAt || Date.now())) / 60_000);
      const openCount = Object.values(activeTgt.groups || {}).filter(g => g.open).length;
      const knownCount = Object.keys(activeTgt.knownGroups || {}).length;

      await tgSend(
        `🟢 <b>Watcher v15</b>\n` +
        `⏱ <b>${uptimeMin}m</b> | RSS: <b>${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB</b>\n\n` +
        `🎯 <b>${escapeHtml(activeCode)}</b>\n` +
        `📋 Status: ${activeTgt.status != null ? statusLabel(activeTgt.status) : '—'}\n` +
        `👥 Groups: <b>${knownCount}</b> known | 🔥 <b>${openCount}</b> open\n` +
        `⏱️ Intervals: groups=<b>${state.intervals.groups / 1000}s</b>, courses=<b>${state.intervals.courses / 1000}s</b>\n\n` +
        `🛡️ Baseline (${state.registeredCourses.length}): ${state.registeredCourses.slice(0, 5).map(c => `<code>${escapeHtml(c.code)}</code>`).join(' ') || '—'}\n\n` +
        `📊 opens=${state.counters.opens} new=${state.counters.newGroups} ` +
        `seat+=${state.counters.seatIncreases} schedule=${state.counters.scheduleChanges || 0} ` +
        `alerts=${state.counters.alertsSent} dedup=${state.counters.dedupHits} err=${state.counters.errors}`
      );
      break;
    }

    case '/groups': {
      if (!activeTgt.id) {
        await tgSend(`⏳ Target "<b>${escapeHtml(activeCode)}</b>" not seen yet`);
        break;
      }

      const r = await api.getCourseSchedule(activeTgt.id);
      if (r.kind !== 'ok' || !r.groups?.length) {
        await tgSend(`❌ No groups`);
        break;
      }

      const sorted = [...r.groups].sort((a, b) =>
        (a.available !== b.available) ? (a.available ? -1 : 1) : a.name.localeCompare(b.name)
      );

      let msg = `🎯 <b>${escapeHtml(activeCode)} — ${r.groups.length} groups</b>\n\n`;

      sorted.slice(0, 20).forEach(g => {
        const icon = g.available ? '🔥' : (g.blocked ? '🚫' : '❄️');
        msg += `${icon} <b>${escapeHtml(g.name)}</b> — 💺 ${g.seats}/${g.total}\n`;
        if (g.slots[0]) {
          msg += `   📅 ${escapeHtml(g.slots[0].day)} | ⏰ ${escapeHtml(g.slots[0].time)}\n`;
        }
      });

      await tgSend(msg);
      break;
    }

    case '/open': {
      const open = Object.entries(activeTgt.groups || {})
        .filter(([_, v]) => v.open)
        .map(([n, v]) => ({ name: n, ...v }));

      if (!open.length) {
        await tgSend(`❄️ No open groups`);
        break;
      }

      let msg = `🔥 <b>Open (${open.length}):</b>\n\n`;
      open.forEach((g, i) => {
        msg += `${i + 1}. <b>${escapeHtml(g.name)}</b> — 💺 ${g.seats}/${g.total}\n`;
      });
      await tgSend(msg);
      break;
    }

    case '/schedule': {
      const r = await api.getStudentTable();
      if (r.kind !== 'ok') {
        await tgSend(`❌ API: ${r.kind}`);
        break;
      }

      const items = Array.isArray(r.data) ? r.data : [];
      if (!items.length) {
        await tgSend(`📅 No schedule data`);
        break;
      }

      let msg = `📅 <b>Schedule (${items.length} entries)</b>\n\n`;
      items.slice(0, 15).forEach(item => {
        msg += `📚 <b>${escapeHtml(item.Name || '?')}</b>\n`;
        msg += `   📅 ${escapeHtml(item.DayWeekName || '?')} | ⏰ ${escapeHtml(item.Time || '?')}\n`;
        msg += `   🏛 ${escapeHtml(item.ClassRoomName || '?')}\n`;
        msg += `   👤 ${escapeHtml((item.Staff || '').slice(0, 40))}\n\n`;
      });
      await tgSend(msg);
      break;
    }

    case '/interval': {
      const sub = (args[0] || '').toLowerCase();
      const val = parseInt(args[1]) || 0;

      if (sub === 'groups' && val >= 3 && val <= 3600) {
        state.intervals.groups = val * 1000;
        await tgSend(`✅ Groups interval → <b>${val}s</b>`);
      } else if (sub === 'courses' && val >= 30 && val <= 3600) {
        state.intervals.courses = val * 1000;
        await tgSend(`✅ Courses interval → <b>${val}s</b>`);
      } else if (sub === 'schedule' && val >= 60 && val <= 3600) {
        state.intervals.schedule = val * 1000;
        await tgSend(`✅ Schedule interval → <b>${val}s</b>`);
      } else {
        await tgSend(
          `⏱️ <b>Intervals</b>\n\n` +
          `Groups: <b>${state.intervals.groups / 1000}s</b>\n` +
          `Courses: <b>${state.intervals.courses / 1000}s</b>\n` +
          `Schedule: <b>${state.intervals.schedule / 1000}s</b>\n\n` +
          `Commands:\n` +
          `<code>/interval groups 5</code>\n` +
          `<code>/interval courses 300</code>\n` +
          `<code>/interval schedule 300</code>`
        );
      }
      break;
    }

    case '/alerts': {
      const active = Object.entries(state.activeAlerts || {});
      if (!active.length) {
        await tgSend(`✅ No active alerts`);
        break;
      }

      let msg = `🔔 <b>Active alerts (${active.length})</b>\n\n`;
      active.slice(0, 10).forEach(([id, a]) => {
        msg += `• <b>${escapeHtml(a.type || '?')}</b>`;
        if (a.group) msg += ` — ${escapeHtml(a.group)}`;
        msg += `\n  منذ ${formatDuration(Date.now() - (a.createdAt || Date.now()))}\n`;
        msg += `  Send count: ${a.sendCount || 1}\n\n`;
      });
      await tgSend(msg);
      break;
    }

    case '/stop':
      state.activeAlerts = {};
      await tgSend(`🔕 <b>All alerts stopped</b>`);
      break;

    case '/diag': {
      const r = await api.getCourses({ forceRefresh: true });
      if (r.kind !== 'ok') {
        await tgSend(`❌ API: ${r.kind}`);
        break;
      }

      const by = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [] };
      for (const c of r.courses) {
        const s = Number(c.status);
        if (by[s]) by[s].push(c.code);
      }

      let msg = `🩺 <b>Diagnostic</b>\n\n📊 Total: <b>${r.courses.length}</b>\n\n`;
      for (const [s, codes] of Object.entries(by)) {
        if (!codes.length) continue;
        msg += `${statusLabel(Number(s))} (${codes.length}):\n`;
        msg += `<code>${codes.slice(0, 15).map(escapeHtml).join(', ')}</code>\n\n`;
      }
      await tgSend(msg);
      break;
    }

    case '/audit': {
      const last = state.audit.slice(-10).map(e =>
        `• <code>${new Date(e.t).toISOString().slice(11, 19)}</code> ${escapeHtml(e.event)}`
      ).join('\n');
      await tgSend(`📜 <b>Last 10</b>\n${last || '—'}`);
      break;
    }

    case '/pause':
      state.paused = true;
      await tgSend('⏸️ Paused');
      break;

    case '/resume':
      state.paused = false;
      await tgSend('▶️ Resumed');
      break;

    case '/reset':
      for (const code of Object.keys(state.targets)) {
        state.targets[code].groups      = {};
        state.targets[code].knownGroups = {};
        state.targets[code].firstScanDone = false;
      }
      state.registeredCourses = [];
      state.sentAlerts        = {};
      state.activeAlerts      = {};
      await tgSend('🔄 Reset done');
      break;

    case '/help':
      await tgSend(
        `🤖 <b>Commands</b>\n\n` +
        BOT_COMMANDS.map(c => `/<b>${c.command}</b> — ${c.description}`).join('\n'),
        { replyMarkup: MAIN_KEYBOARD }
      );
      break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  PERSISTENT ALERTS
// ═══════════════════════════════════════════════════════════════════════════
async function repeatActiveAlerts(state) {
  const active = state.activeAlerts || {};
  const now = Date.now();
  const REPEAT_INTERVAL = 20_000;

  for (const [id, alert] of Object.entries(active)) {
    const elapsed = now - (alert.lastSentAt || alert.createdAt || now);
    if (elapsed < REPEAT_INTERVAL) continue;

    alert.sendCount = (alert.sendCount || 0) + 1;
    alert.lastSentAt = now;

    let msg = `🔔 <b>${escapeHtml(alert.type || 'Alert')}</b>\n`;
    if (alert.group) msg += `🎯 ${escapeHtml(alert.group)}\n`;
    if (alert.course) msg += `📚 ${escapeHtml(alert.course)}\n`;
    if (alert.details) msg += `${escapeHtml(alert.details)}\n`;
    msg += `\n⏱ منذ ${formatDuration(now - (alert.createdAt || now))}\n`;
    msg += `📨 Sent: <b>${alert.sendCount}</b> times\n\n`;
    msg += `Send /stop to silence`;

    await tgSend(msg, { silent: false });
  }

  // Auto-cleanup: remove alerts older than 1 hour
  for (const [id, alert] of Object.entries(active)) {
    if (now - (alert.createdAt || now) > 60 * 60_000) {
      delete active[id];
    }
  }
}

function createPersistentAlert(state, type, { course, group, details }) {
  const id = `${type}_${Date.now()}`;
  state.activeAlerts[id] = {
    type,
    course,
    group,
    details,
    createdAt:  Date.now(),
    lastSentAt: 0,
    sendCount:  0,
  };
  return id;
}

// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════
module.exports = {
  tgSend,
  registerBotCommands,
  pollTelegram,
  handleCommand,
  repeatActiveAlerts,
  createPersistentAlert,
  MAIN_KEYBOARD,
};
