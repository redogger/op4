/* ═══════════════════════════════════════════════════════════════════════════
 *  DULMS Watcher v15 — Watchers (Detection Logic)
 *  ═══════════════════════════════════════════════════════════════════════════
 *  - Course Watch    → كشف ظهور مادة
 *  - Group Watch     → مجموعة جديدة + فتحت + مقاعد زادت + حجب
 *  - Schedule Watch  → المواعيد اتغيرت (المواد المسجلة)
 *  - Security Guard  → مادة اتشالت
 * ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const {
  log,
  audit,
  escapeHtml,
  normalizeCode,
  statusLabel,
  makeFingerprint,
  shouldSendAlert,
} = require('./core');

const {
  tgSend,
  createPersistentAlert,
} = require('./telegram');

// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function sameCourse(a, b) {
  if (a.id && b.id) return String(a.id) === String(b.id);
  return a.code && b.code && normalizeCode(a.code) === normalizeCode(b.code);
}

function filterByWatch(groups, watchList) {
  if (!watchList || !watchList.length) return groups;
  const w = watchList.map(x => x.toUpperCase());
  return groups.filter(g =>
    w.some(p => String(g.name || '').toUpperCase().includes(p))
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  1. COURSE WATCH — كشف ظهور مادة
// ═══════════════════════════════════════════════════════════════════════════
async function runCourseWatch(api, state, userTargets) {
  state.counters.scans++;
  state.earlyDetection = state.earlyDetection || { checks: 0, hits: 0 };
  state.earlyDetection.checks++;
  state.earlyDetection.lastCheck = Date.now();

  const r = await api.getCourses({ forceRefresh: true });
  if (r.kind !== 'ok') {
    log.warn(`CourseWatch: ${r.kind}`);
    return;
  }

  for (const t of userTargets) {
    if (state.targets[t.code]?.id) continue;

    const qNorm = normalizeCode(t.code);
    const qRaw  = String(t.code).toUpperCase().trim();
    const qNoSp = qRaw.replace(/\s+/g, '');

    const found = r.courses.find(c =>
      normalizeCode(c.code) === qNorm ||
      String(c.code).toUpperCase().trim() === qRaw ||
      normalizeCode(c.code).includes(qNorm) ||
      String(c.name).toUpperCase().includes(qRaw) ||
      String(c.name).toUpperCase().replace(/\s+/g, '').includes(qNoSp)
    );

    if (!found) continue;

    state.earlyDetection.hits++;

    state.targets[t.code] = {
      id:            found.id,
      name:          found.name,
      status:        found.status,
      apiCode:       found.code,
      groups:        {},
      knownGroups:   {},
      watchGroups:   [],
      firstScanDone: false,
      detectedAt:    Date.now(),
    };

    state._activeTarget = t.code;
    audit(state, 'course_appeared', { code: found.code, id: found.id });

    const fp = makeFingerprint('course_appeared', { code: t.code, id: found.id });
    if (!shouldSendAlert(state, fp, 60 * 60 * 1000)) {
      log.info(`[dedup] course_appeared for ${t.code}`);
      continue;
    }

    log.ok(`🎉 EARLY: ${found.code} id=${found.id}`);
    state.counters.alertsSent++;

    await tgSend(
      `🎉🎉 <b>${escapeHtml(t.code)} ظهرت!</b>\n\n` +
      `📋 <code>${escapeHtml(found.code)}</code>\n` +
      `📚 ${escapeHtml(found.name)}\n` +
      `🆔 <code>${escapeHtml(found.id)}</code>\n` +
      `📊 ${statusLabel(found.status)}\n\n` +
      `⚡ بدأ المراقبة…\n📋 /groups`
    );

    // Persistent alert
    createPersistentAlert(state, 'course_appeared', {
      course:  t.code,
      details: `${found.name}`,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  2. GROUP WATCH — 4 signals
// ═══════════════════════════════════════════════════════════════════════════
async function runGroupWatch(api, state) {
  for (const [code, tgt] of Object.entries(state.targets)) {
    if (!tgt.id) continue;

    const r = await api.getCourseSchedule(tgt.id);
    if (r.kind === 'session_dead') {
      return { kind: 'session_dead', target: code };
    }
    if (r.kind !== 'ok') {
      log.warn(`GroupWatch(${code}): ${r.kind}`);
      continue;
    }

    const allGroups = (r.groups || []).filter(g => g?.name);
    const watched   = filterByWatch(allGroups, tgt.watchGroups);

    tgt.groups      = tgt.groups      || {};
    tgt.knownGroups = tgt.knownGroups || {};

    const isFirstScan = !tgt.firstScanDone;

    if (isFirstScan) {
      log.info(`[first-scan] ${code}: ${allGroups.length} groups (silent)`);
      tgt.firstScanDone = true;
    } else {
      // ─── Signal 1: New group ────────────────────────────────
      const newGroups = watched.filter(g => !tgt.knownGroups[g.name]);
      if (newGroups.length > 0) {
        const fp = makeFingerprint('new_group', {
          code,
          names: newGroups.map(g => g.name).sort(),
        });
        if (shouldSendAlert(state, fp, 10 * 60 * 1000)) {
          state.counters.newGroups += newGroups.length;
          state.counters.alertsSent++;
          audit(state, 'new_group', { code, groups: newGroups.map(g => g.name) });

          let msg = `🆕 <b>${escapeHtml(code)} — ${newGroups.length} مجموعة جديدة!</b>\n\n`;
          newGroups.forEach((g, i) => {
            msg += `<b>${i + 1}. ${escapeHtml(g.name)}</b> — 💺 ${g.seats}/${g.total}\n`;
            if (g.slots[0]) {
              msg += `   📅 ${escapeHtml(g.slots[0].day)} | ⏰ ${escapeHtml(g.slots[0].time)}\n`;
            }
            if (g.available) {
              msg += `   🔥 <b>فيها مقاعد!</b>\n`;
            }
            msg += `\n`;
          });
          msg += `🔗 افتح DULMS`;
          await tgSend(msg, { silent: false });
        }
      }

      // ─── Signal 2: Group opened ─────────────────────────────
      const newlyOpened = watched.filter(g =>
        g.available && !tgt.groups[g.name]?.open
      );
      if (newlyOpened.length > 0) {
        const fp = makeFingerprint('group_open', {
          code,
          names: newlyOpened.map(g => g.name).sort(),
        });
        if (shouldSendAlert(state, fp, 5 * 60 * 1000)) {
          state.counters.opens += newlyOpened.length;
          state.counters.alertsSent++;
          audit(state, 'group_open', { code, groups: newlyOpened.map(g => g.name) });

          let msg = `🎉 <b>${escapeHtml(code)} — ${newlyOpened.length} فتحت!</b>\n\n`;
          newlyOpened.slice(0, 8).forEach((g, i) => {
            msg += `<b>${i + 1}. ${escapeHtml(g.name)}</b> — 💺 ${g.seats}/${g.total}\n`;
            if (g.slots[0]) {
              msg += `   📅 ${escapeHtml(g.slots[0].day)} | ⏰ ${escapeHtml(g.slots[0].time)}\n`;
            }
            if (g.slots[0]?.hall) {
              msg += `   🏛 ${escapeHtml(g.slots[0].hall)}\n`;
            }
            msg += `\n`;
          });
          msg += `🔗 <b>افتح DULMS حالاً!</b>`;
          await tgSend(msg, { silent: false });

          // Persistent alert
          createPersistentAlert(state, 'group_opened', {
            course:  code,
            group:   newlyOpened[0].name,
            details: `💺 ${newlyOpened[0].seats}/${newlyOpened[0].total}`,
          });
        }
      }

      // ─── Signal 3: Seat increase ────────────────────────────
      const increases = watched.filter(g => {
        const prev = tgt.groups[g.name]?.seats;
        return g.available && prev != null && g.seats > prev && !newlyOpened.includes(g);
      });
      if (increases.length > 0) {
        const fp = makeFingerprint('seat_increase', {
          code,
          changes: increases.map(g =>
            `${g.name}:${tgt.groups[g.name]?.seats}→${g.seats}`
          ).sort(),
        });
        if (shouldSendAlert(state, fp, 2 * 60 * 1000)) {
          state.counters.seatIncreases += increases.length;
          state.counters.alertsSent++;
          audit(state, 'seat_increase', {
            code,
            changes: increases.map(g =>
              `${g.name}:${tgt.groups[g.name]?.seats}→${g.seats}`
            ),
          });

          let msg = `📈 <b>${escapeHtml(code)} — مقاعد زادت!</b>\n\n`;
          increases.forEach((g, i) => {
            const prev = tgt.groups[g.name]?.seats || 0;
            msg += `<b>${i + 1}. ${escapeHtml(g.name)}</b> — 💺 ${prev} → <b>${g.seats}</b>/${g.total}\n\n`;
          });
          msg += `🔗 <b>افتح DULMS حالاً!</b>`;
          await tgSend(msg, { silent: false });
        }
      }

      // ─── Signal 4: Block change ─────────────────────────────
      const blockChanges = watched.filter(g => {
        const prev = tgt.groups[g.name]?.blocked;
        return prev != null && prev !== g.blocked;
      });
      if (blockChanges.length > 0) {
        const fp = makeFingerprint('block_change', {
          code,
          changes: blockChanges.map(g =>
            `${g.name}:${tgt.groups[g.name]?.blocked}→${g.blocked}`
          ).sort(),
        });
        if (shouldSendAlert(state, fp, 10 * 60 * 1000)) {
          state.counters.blockChanges += blockChanges.length;
          state.counters.alertsSent++;
          audit(state, 'block_change', {
            code,
            changes: blockChanges.map(g => `${g.name}:${g.blocked}`),
          });

          let msg = `🚫 <b>${escapeHtml(code)} — حالة الحجب اتغيرت!</b>\n\n`;
          blockChanges.forEach((g, i) => {
            const icon = g.blocked ? '🔒 محجوبة' : '🔓 مفتوحة';
            msg += `<b>${i + 1}. ${escapeHtml(g.name)}</b> — ${icon}\n\n`;
          });
          await tgSend(msg, { silent: false });
        }
      }
    }

    // ─── Update snapshot ──────────────────────────────────────
    for (const g of allGroups) {
      tgt.groups[g.name] = {
        open:     g.available,
        blocked:  g.blocked,
        seats:    g.seats,
        total:    g.total,
        lastSeen: Date.now(),
      };
      tgt.knownGroups[g.name] = tgt.knownGroups[g.name] || {
        firstSeen: Date.now(),
      };
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  3. SCHEDULE WATCH — مراقبة المواعيد للمواد المسجلة
// ═══════════════════════════════════════════════════════════════════════════
async function runScheduleWatch(api, state) {
  const r = await api.getStudentTable();
  if (r.kind === 'session_dead') {
    return { kind: 'session_dead' };
  }
  if (r.kind !== 'ok') {
    log.warn(`ScheduleWatch: ${r.kind}`);
    return;
  }

  const items = Array.isArray(r.data) ? r.data : [];
  if (!items.length) return;

  // Group by course
  const byCourse = {};
  for (const item of items) {
    const courseName = String(item.Name || '').trim();
    if (!courseName) continue;

    if (!byCourse[courseName]) {
      byCourse[courseName] = [];
    }

    byCourse[courseName].push({
      day:   String(item.DayWeekName || '').trim(),
      time:  String(item.Time        || '').trim(),
      hall:  String(item.ClassRoomName || '').trim(),
      staff: String(item.Staff || '').trim(),
      group: String(item.GroupName || '').trim(),
    });
  }

  // Compare each course's schedule with saved snapshot
  for (const [courseName, entries] of Object.entries(byCourse)) {
    const newSnapshot = entries
      .map(e => `${e.day}|${e.time}|${e.hall}|${e.staff}|${e.group}`)
      .sort()
      .join('§');

    const oldSnapshot = state.scheduleSnapshots[courseName];
    if (!oldSnapshot) {
      // First time — save silently
      state.scheduleSnapshots[courseName] = {
        hash:    newSnapshot,
        entries: entries,
        savedAt: Date.now(),
      };
      log.info(`[schedule] ${courseName}: ${entries.length} entries (baseline)`);
      continue;
    }

    if (oldSnapshot.hash === newSnapshot) continue;

    // Schedule changed!
    const changes = [];

    // Find changed/new entries
    for (const entry of entries) {
      const oldEntry = oldSnapshot.entries.find(o =>
        o.day === entry.day && o.group === entry.group
      );

      if (!oldEntry) {
        changes.push({ type: 'new_slot', entry });
        continue;
      }

      if (oldEntry.time  !== entry.time)  changes.push({ type: 'time_changed',  oldEntry, entry });
      if (oldEntry.hall  !== entry.hall)  changes.push({ type: 'hall_changed',  oldEntry, entry });
      if (oldEntry.staff !== entry.staff) changes.push({ type: 'staff_changed', oldEntry, entry });
    }

    // Find removed entries
    for (const oldEntry of oldSnapshot.entries) {
      const stillExists = entries.find(e =>
        e.day === oldEntry.day && e.group === oldEntry.group
      );
      if (!stillExists) {
        changes.push({ type: 'slot_removed', oldEntry });
      }
    }

    if (!changes.length) continue;

    // Build alert message
    const fp = makeFingerprint('schedule_change', {
      course:  courseName,
      changes: changes.map(c => c.type).sort(),
    });

    if (!shouldSendAlert(state, fp, 30 * 60 * 1000)) {
      state.scheduleSnapshots[courseName] = {
        hash:    newSnapshot,
        entries: entries,
        savedAt: Date.now(),
      };
      continue;
    }

    state.counters.scheduleChanges++;
    state.counters.alertsSent++;
    audit(state, 'schedule_change', {
      course:  courseName,
      changes: changes.map(c => c.type),
    });

    let msg = `🔄 <b>تغيير في الجدول!</b>\n\n`;
    msg += `📚 <b>${escapeHtml(courseName)}</b>\n\n`;

    const grouped = changes.slice(0, 6).map(c => {
      switch (c.type) {
        case 'time_changed':
          return `⏰ <b>الوقت اتغير</b>\n   ${escapeHtml(c.oldEntry.time)} → <b>${escapeHtml(c.entry.time)}</b>`;
        case 'hall_changed':
          return `🏛 <b>القاعة اتغيرت</b>\n   ${escapeHtml(c.oldEntry.hall)} → <b>${escapeHtml(c.entry.hall)}</b>`;
        case 'staff_changed':
          return `👤 <b>الدكتور اتغير</b>\n   ${escapeHtml(c.oldEntry.staff.slice(0, 30))} → <b>${escapeHtml(c.entry.staff.slice(0, 30))}</b>`;
        case 'new_slot':
          return `➕ <b>موعد جديد</b>\n   ${escapeHtml(c.entry.day)} | ${escapeHtml(c.entry.time)} | ${escapeHtml(c.entry.hall)}`;
        case 'slot_removed':
          return `➖ <b>موعد اتشال</b>\n   ${escapeHtml(c.oldEntry.day)} | ${escapeHtml(c.oldEntry.time)}`;
        default:
          return '';
      }
    }).filter(Boolean);

    msg += grouped.join('\n\n');
    msg += `\n\n🔗 افتح DULMS`;

    await tgSend(msg, { silent: false });

    // Persistent alert
    createPersistentAlert(state, 'schedule_change', {
      course:  courseName,
      details: `${changes.length} changes`,
    });

    // Update snapshot
    state.scheduleSnapshots[courseName] = {
      hash:    newSnapshot,
      entries: entries,
      savedAt: Date.now(),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  4. SECURITY GUARD — مادة اتشالت من المواد المسجلة
// ═══════════════════════════════════════════════════════════════════════════
async function runSecurityGuard(api, state) {
  const r = await api.getCourses();
  if (r.kind !== 'ok') return { kind: r.kind };

  const currentReg = r.courses
    .filter(c => Number(c.status) === 3 || Number(c.status) === 4)
    .map(c => ({ id: c.id, code: c.code, name: c.name }));

  if (!state.registeredCourses.length) {
    state.registeredCourses = currentReg;
    log.ok(`Baseline: ${currentReg.length} courses`);
    audit(state, 'baseline_set', { codes: currentReg.map(c => c.code) });
    return { kind: 'ok' };
  }

  // Course drops
  for (const saved of state.registeredCourses) {
    if (!currentReg.some(c => sameCourse(c, saved))) {
      const fp = makeFingerprint('course_drop', { code: saved.code, id: saved.id });
      if (shouldSendAlert(state, fp, 30 * 60 * 1000)) {
        state.counters.drops++;
        state.counters.alertsSent++;
        audit(state, 'course_dropped', { code: saved.code });
        await tgSend(
          `🚨 <b>مادة اتشالت!</b>\n❌ ${escapeHtml(saved.code)} — ${escapeHtml(saved.name)}`,
          { silent: false }
        );
      }
    }
  }

  // New courses
  for (const curr of currentReg) {
    if (!state.registeredCourses.some(s => sameCourse(s, curr))) {
      state.counters.adds++;
      audit(state, 'course_added', { code: curr.code });
      await tgSend(`✅ <b>مادة جديدة!</b>\n➕ ${escapeHtml(curr.code)}`);
    }
  }

  state.registeredCourses = currentReg;
  return { kind: 'ok' };
}

// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════
module.exports = {
  runCourseWatch,
  runGroupWatch,
  runScheduleWatch,
  runSecurityGuard,
};
