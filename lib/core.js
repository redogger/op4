/* ═══════════════════════════════════════════════════════════════════════════
 *  DULMS Watcher v15 — Core Utilities
 *  ═══════════════════════════════════════════════════════════════════════════
 *  - Logger (timestamp حقيقي)
 *  - Crypto (AES-256-GCM)
 *  - State management
 *  - Redaction
 *  - Dedup
 *  - Audit trail
 *  - Time utilities
 * ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════
const ENC_PREFIX = 'ENC1:';
const VERSION    = 'v15.0';

const FILES = {
  state:      path.join(process.cwd(), '.dulms-state.json'),
  stateTmp:   path.join(process.cwd(), '.dulms-state.json.tmp'),
  audit:      path.join(process.cwd(), '.dulms-audit.log'),
  auditOld:   path.join(process.cwd(), '.dulms-audit.log.old'),
  auditMax:   1 * 1024 * 1024,
};

// ═══════════════════════════════════════════════════════════════════════════
//  1. REDACTION
// ═══════════════════════════════════════════════════════════════════════════
const REDACT_PATTERNS = [
  /(ASP\.NET_SessionId)\s*[=:]\s*["']?([^;"'\s]+)/gi,
  /(\.AUTH)\s*[=:]\s*["']?([^;"'\s]+)/gi,
  /(sessionid)\s*[=:]\s*["']?([^;"'\s]+)/gi,
  /(Bearer)\s+([A-Za-z0-9._\-+/=]+)/gi,
];

function redact(s) {
  let out = String(s ?? '');
  const secrets = [
    process.env.DULMS_PASSWORD,
    process.env.DULMS_USERNAME,
    process.env.TG_TOKEN,
    process.env.STATE_ENCRYPTION_KEY,
  ];
  for (const secret of secrets) {
    if (secret && String(secret).length >= 4) {
      out = out.split(String(secret)).join('«redacted»');
    }
  }
  for (const pattern of REDACT_PATTERNS) {
    out = out.replace(pattern, '$1=«redacted»');
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  2. LOGGER — timestamp حقيقي في كل نداء
// ═══════════════════════════════════════════════════════════════════════════
const _ts = () => new Date().toISOString().slice(11, 19);

function _makeLogFn(method, level, { newline = false } = {}) {
  return (...args) => {
    const cleaned = args.map(x => typeof x === 'string' ? redact(x) : x);
    const prefix  = `${newline ? '\n' : ''}[${_ts()}] ${level}`;
    method(prefix, ...cleaned);
  };
}

const log = {
  info: _makeLogFn(console.log.bind(console),   '[INFO]'),
  ok:   _makeLogFn(console.log.bind(console),   '[ OK ]'),
  warn: _makeLogFn(console.warn.bind(console),  '[WARN]'),
  err:  _makeLogFn(console.error.bind(console), '[FAIL]'),
  step: _makeLogFn(console.log.bind(console),   '━━━', { newline: true }),
  sess: _makeLogFn(console.log.bind(console),   '[SESS]'),
  tg:   _makeLogFn(console.log.bind(console),   '[ TG ]'),
  det:  _makeLogFn(console.log.bind(console),   '[DET ]'),
};

// ═══════════════════════════════════════════════════════════════════════════
//  3. CRYPTO (AES-256-GCM)
// ═══════════════════════════════════════════════════════════════════════════
let _encWarned = false;

function _getKey() {
  const k = process.env.STATE_ENCRYPTION_KEY || '';
  if (!k) {
    if (!_encWarned) {
      console.warn('[WARN] STATE_ENCRYPTION_KEY missing — PLAINTEXT mode');
      _encWarned = true;
    }
    return null;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(k)) {
    throw new Error('STATE_ENCRYPTION_KEY must be 64 hex chars');
  }
  return Buffer.from(k, 'hex');
}

function encryptString(plain) {
  const key = _getKey();
  if (!key) return String(plain);
  const iv  = crypto.randomBytes(12);
  const c   = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ENC_PREFIX + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decryptString(data) {
  const s = String(data);
  if (!s.startsWith(ENC_PREFIX)) return s;
  const key = _getKey();
  if (!key) throw new Error('Encrypted file but STATE_ENCRYPTION_KEY missing');
  const buf = Buffer.from(s.slice(ENC_PREFIX.length), 'base64');
  const iv  = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ═══════════════════════════════════════════════════════════════════════════
//  4. FILE UTILITIES
// ═══════════════════════════════════════════════════════════════════════════
function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function atomicWriteEnc(file, data) {
  const plain = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  atomicWrite(file, encryptString(plain));
}

function readFileDec(file) {
  return decryptString(fs.readFileSync(file, 'utf8'));
}

function rotateAuditIfNeeded() {
  try {
    if (!fs.existsSync(FILES.audit)) return;
    if (fs.statSync(FILES.audit).size <= FILES.auditMax) return;
    if (fs.existsSync(FILES.auditOld)) fs.unlinkSync(FILES.auditOld);
    fs.renameSync(FILES.audit, FILES.auditOld);
  } catch (e) {
    log.warn('audit rotate failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  5. TIME UTILITIES
// ═══════════════════════════════════════════════════════════════════════════
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function timeSince(t) {
  if (!t) return 'never';
  const d = Date.now() - t;
  if (d < 0) return 'in future';
  return `${formatDuration(d)} ago`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  6. STRING UTILITIES
// ═══════════════════════════════════════════════════════════════════════════
function escapeHtml(s) {
  const map = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
  return String(s).replace(/[&<>"']/g, c => map[c]);
}

function normalizeCode(s) {
  return String(s || '').toUpperCase().replace(/\s+/g, '').replace(/-/g, '');
}

function statusLabel(s) {
  const m = { 0:'❌ Failed', 1:'✅ Passed', 2:'↩️ Withdrawn', 3:'⏳ Pending', 4:'📝 Registered', 5:'🆕 Never' };
  return s == null ? '❓' : (m[Number(s)] || `❓ (${s})`);
}

function truncate(s, max = 3800) {
  const str = String(s ?? '');
  return str.length <= max ? str : str.slice(0, max - 20) + '\n… (truncated)';
}

function makeFingerprint(type, payload) {
  return crypto.createHash('sha1')
    .update(`${type}:${JSON.stringify(payload)}`)
    .digest('hex').slice(0, 16);
}

// ═══════════════════════════════════════════════════════════════════════════
//  7. STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════
function defaultState() {
  return {
    version:          150,
    startedAt:        0,
    registeredCourses: [],
    targets:          {},
    pendingCallbacks: {},
    _cbCounter:       0,
    lastTgUpdateId:   0,
    tgChatId:         null,
    startupBriefedAt: 0,
    paused:           false,
    lastError:        null,
    sentAlerts:       {},
    activeAlerts:     {},
    intervals: {
      groups:   5000,
      courses:  300000,
      schedule: 300000,
    },
    sessionStats: {
      logins:      0,
      reuses:      0,
      relogins:    0,
      failures:    0,
      lastLoginAt: 0,
    },
    counters: {
      opens:          0,
      newGroups:      0,
      seatIncreases:  0,
      blockChanges:   0,
      drops:          0,
      adds:           0,
      alertsSent:     0,
      dedupHits:      0,
      relogins:       0,
      errors:         0,
      scans:          0,
      scheduleChanges: 0,
    },
    scheduleSnapshots: {},
    audit: [],
  };
}

function migrateState(s) {
  if (!s || typeof s !== 'object') return defaultState();
  const base = defaultState();
  const merged = {
    ...base, ...s,
    counters:          { ...base.counters,          ...(s.counters          || {}) },
    sessionStats:      { ...base.sessionStats,      ...(s.sessionStats      || {}) },
    intervals:         { ...base.intervals,         ...(s.intervals         || {}) },
    sentAlerts:        s.sentAlerts        || {},
    activeAlerts:      s.activeAlerts      || {},
    targets:           s.targets           || {},
    scheduleSnapshots: s.scheduleSnapshots || {},
  };
  merged.audit = Array.isArray(merged.audit) ? merged.audit.slice(-500) : [];
  if (!merged.pendingCallbacks || typeof merged.pendingCallbacks !== 'object') {
    merged.pendingCallbacks = {};
  }
  if (typeof merged._cbCounter !== 'number') merged._cbCounter = 0;
  merged.version = 150;
  return merged;
}

function loadState() {
  try {
    if (fs.existsSync(FILES.state)) {
      return migrateState(JSON.parse(readFileDec(FILES.state)));
    }
  } catch (e) {
    log.warn('State load failed:', e.message);
  }
  return defaultState();
}

function saveState(state) {
  try {
    atomicWriteEnc(FILES.state, state);
  } catch (e) {
    log.warn('State save failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  8. AUDIT TRAIL
// ═══════════════════════════════════════════════════════════════════════════
function audit(state, event, details = {}) {
  const entry = { t: Date.now(), event };
  for (const [k, v] of Object.entries(details)) {
    entry[k] = typeof v === 'string' ? redact(v) : v;
  }
  state.audit.push(entry);
  if (state.audit.length > 500) {
    state.audit = state.audit.slice(-500);
  }
  try {
    rotateAuditIfNeeded();
    fs.appendFileSync(FILES.audit, JSON.stringify(entry) + '\n');
  } catch (e) {
    log.warn('audit append failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  9. DEDUP — منع تكرار التنبيهات
// ═══════════════════════════════════════════════════════════════════════════
function shouldSendAlert(state, fingerprint, windowMs = 5 * 60 * 1000) {
  state.sentAlerts = state.sentAlerts || {};
  const now = Date.now();

  // Cleanup old fingerprints
  const cleanupThreshold = windowMs * 4;
  for (const [k, t] of Object.entries(state.sentAlerts)) {
    if (now - t > cleanupThreshold) delete state.sentAlerts[k];
  }

  const last = state.sentAlerts[fingerprint];
  if (last && (now - last) < windowMs) {
    state.counters.dedupHits = (state.counters.dedupHits || 0) + 1;
    log.warn(`[dedup] suppressed ${fingerprint} (${Math.round((now - last) / 1000)}s ago)`);
    return false;
  }

  state.sentAlerts[fingerprint] = now;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
//  10. ASYNC UTILITIES
// ═══════════════════════════════════════════════════════════════════════════
async function withTimeout(promise, ms, label = 'op') {
  let timer;
  const to = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, to]);
  } finally {
    clearTimeout(timer);
  }
}

async function retry(fn, { attempts = 3, baseMs = 800, label = 'op' } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      const retryable = /timeout|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|aborted/i.test(msg);
      if (!retryable || i === attempts - 1) throw e;
      const b = baseMs * Math.pow(2, i) + Math.floor(Math.random() * 250);
      log.warn(`[retry ${label}] ${i + 1}/${attempts}: ${msg} — retry ${b}ms`);
      await sleep(b);
    }
  }
  throw lastErr;
}

// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════
module.exports = {
  VERSION,
  FILES,
  // Logger
  log,
  // Crypto
  encryptString,
  decryptString,
  redact,
  // Files
  atomicWrite,
  atomicWriteEnc,
  readFileDec,
  // Time
  sleep,
  formatDuration,
  timeSince,
  // Strings
  escapeHtml,
  normalizeCode,
  statusLabel,
  truncate,
  makeFingerprint,
  // State
  defaultState,
  migrateState,
  loadState,
  saveState,
  // Audit
  audit,
  // Dedup
  shouldSendAlert,
  // Async
  withTimeout,
  retry,
};
