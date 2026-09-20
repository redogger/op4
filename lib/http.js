/* ═══════════════════════════════════════════════════════════════════════════
 *  DULMS Watcher v15 — HTTP Client + Login
 *  ═══════════════════════════════════════════════════════════════════════════
 *  - axios + tough-cookie
 *  - Login flow: GET /Login.aspx → extract viewstate → POST
 *  - Session validation
 *  - Retry + rate limiting
 * ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const axios    = require('axios');
const cheerio  = require('cheerio');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const { log, sleep, withTimeout } = require('./core');

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════════════════
const BASE_URL   = 'https://dulms.deltauniv.edu.eg';
const LOGIN_URL  = `${BASE_URL}/Login.aspx`;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const TIMEOUTS = {
  request:   15_000,
  login:     30_000,
};

// ═══════════════════════════════════════════════════════════════════════════
//  HTTP CLIENT
// ═══════════════════════════════════════════════════════════════════════════
function createClient() {
  const jar = new CookieJar();

  const client = wrapper(axios.create({
    baseURL: BASE_URL,
    timeout: TIMEOUTS.request,
    jar,
    withCredentials: true,
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 400,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
    },
  }));

  return { client, jar };
}

// ═══════════════════════════════════════════════════════════════════════════
//  LOGIN FLOW
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Step 1: GET /Login.aspx → extract hidden fields + cookies
 */
async function fetchLoginPage(client) {
  const res = await withTimeout(
    client.get('/Login.aspx', { responseType: 'text' }),
    TIMEOUTS.login,
    'fetch-login'
  );

  if (res.status !== 200) {
    throw new Error(`Login page returned ${res.status}`);
  }

  const $ = cheerio.load(res.data);

  const viewState       = $('#__VIEWSTATE').val() || '';
  const viewStateGen    = $('#__VIEWSTATEGENERATOR').val() || '';
  const eventValidation = $('#__EVENTVALIDATION').val() || '';

  if (!viewState) {
    throw new Error('Failed to extract __VIEWSTATE');
  }

  return { viewState, viewStateGen, eventValidation };
}

/**
 * Step 2: POST /Login.aspx with credentials + hidden fields
 */
async function postLogin(client, { viewState, viewStateGen, eventValidation, username, password }) {
  const body = new URLSearchParams({
    '__VIEWSTATE':           viewState,
    '__VIEWSTATEGENERATOR':  viewStateGen,
    '__EVENTVALIDATION':     eventValidation,
    'txtname':               username,
    'txtPass':               password,
    'type':                  '1',        // 1 = Student
    'Button1':               'Login',
  });

  const res = await withTimeout(
    client.post('/Login.aspx', body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer':      LOGIN_URL,
        'Origin':       BASE_URL,
      },
      maxRedirects: 0,  // Don't follow redirect, check manually
    }),
    TIMEOUTS.login,
    'post-login'
  );

  return res;
}

/**
 * Step 3: Verify login succeeded
 */
async function verifyLogin(client, response) {
  // Status 302 → redirect → likely success
  if (response.status === 302) {
    const location = response.headers['location'] || '';
    if (location.includes('/Login.aspx') || location.includes('/login')) {
      return { success: false, reason: 'redirected_back_to_login' };
    }
    return { success: true, redirectTo: location };
  }

  // Status 200 → check content
  if (response.status === 200) {
    const body = String(response.data || '');
    if (body.includes('Login.aspx') && body.includes('txtname')) {
      // Still on login page
      if (/invalid|incorrect|wrong|كلمة المرور|خطأ/i.test(body)) {
        return { success: false, reason: 'invalid_credentials' };
      }
      if (/locked|disabled|blocked/i.test(body)) {
        return { success: false, reason: 'account_locked' };
      }
      return { success: false, reason: 'still_on_login_page' };
    }
    // Different page → success
    return { success: true };
  }

  return { success: false, reason: `unexpected_status_${response.status}` };
}

/**
 * Full login flow
 */
async function login(client, { username, password }) {
  log.sess('Fetching login page...');

  const fields = await fetchLoginPage(client);
  log.sess(`Extracted viewstate (${fields.viewState.length} chars)`);

  log.sess('Posting credentials...');
  const response = await postLogin(client, {
    ...fields,
    username,
    password,
  });

  const verification = await verifyLogin(client, response);

  if (!verification.success) {
    throw new Error(`Login failed: ${verification.reason}`);
  }

  log.ok(`✅ Logged in — redirect to ${verification.redirectTo || 'dashboard'}`);
  return verification;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SESSION VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate current session by hitting a lightweight endpoint
 */
async function validateSession(client) {
  try {
    const res = await withTimeout(
      client.post('/Registered/GetStudentResiterationInfo', null, {
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Referer':          `${BASE_URL}/Registered/CoursesRegisteration`,
        },
        responseType: 'text',
      }),
      10_000,
      'session-validate'
    );

    const body = String(res.data || '').trim();

    // Session dead indicators
    if (res.status === 302) return 'expired';
    if (body === '' || body === '-1' || body === 'null') return 'expired';
    if (body.startsWith('<') && /login|signin/i.test(body)) return 'expired';
    if (body.startsWith('[') || body.startsWith('{')) return 'valid';

    return 'unknown';
  } catch (e) {
    log.warn(`Session validate error: ${e.message}`);
    return 'unknown';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  API CALLS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET / POST with DULMS-specific headers
 */
async function dulmsGet(client, path, params = {}) {
  const qs = Object.keys(params).length > 0
    ? '?' + new URLSearchParams(params).toString()
    : '';

  const res = await withTimeout(
    client.get(path + qs, {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept':           'application/json, text/plain, */*',
        'Referer':          `${BASE_URL}/Registered/CoursesRegisteration`,
      },
      responseType: 'text',
    }),
    TIMEOUTS.request,
    `get ${path}`
  );

  return parseResponse(res);
}

async function dulmsPost(client, path) {
  const res = await withTimeout(
    client.post(path, null, {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept':           'application/json, text/plain, */*',
        'Referer':          `${BASE_URL}/Registered/CoursesRegisteration`,
      },
      responseType: 'text',
    }),
    TIMEOUTS.request,
    `post ${path}`
  );

  return parseResponse(res);
}

function parseResponse(res) {
  const body = String(res.data || '').trim();

  if (res.status === 302 || res.status === 401) {
    return { kind: 'session_dead' };
  }
  if (res.status >= 500) {
    return { kind: 'soft_server' };
  }
  if (body === '' || body === 'null' || body === '-1') {
    return { kind: 'session_dead' };
  }
  if (body.startsWith('<')) {
    if (/login|signin|Login\.aspx/i.test(body)) return { kind: 'session_dead' };
    return { kind: 'soft_server' };
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { kind: 'structural' };
  }

  return { kind: 'ok', data };
}

// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════
module.exports = {
  BASE_URL,
  createClient,
  login,
  validateSession,
  dulmsGet,
  dulmsPost,
};
