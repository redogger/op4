/* ═══════════════════════════════════════════════════════════════════════════
 *  DULMS Watcher v15 — API Client
 *  ═══════════════════════════════════════════════════════════════════════════
 *  - getCourses()         → كل المواد
 *  - getCourseSchedule()  → مجموعات مادة + مواعيد
 *  - getRegInfo()         → معلومات التسجيل
 *  - getStudentTable()    → جدول الطالب
 *  - getAllIntervals()    → mapping الوقت
 * ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const {
  log,
  retry,
  normalizeCode,
  isRegisterable,
} = require('./core');

const { dulmsGet, dulmsPost } = require('./http');

// ═══════════════════════════════════════════════════════════════════════════
//  HELPER: isRegisterable
// ═══════════════════════════════════════════════════════════════════════════
//  (موجودة في core كـ export، بس في حالة الكود هنا عايزينها)
function _isRegisterable(s) {
  return [0, 2, 5].includes(Number(s));
}

// ═══════════════════════════════════════════════════════════════════════════
//  API CLIENT
// ═══════════════════════════════════════════════════════════════════════════
function makeApi(client) {
  let courseCache = { ts: 0, data: null };
  const CACHE_TTL = 8 * 1000;

  return {

    // ─────────────────────────────────────────────────────────────────
    //  getCourses — كل المواد
    // ─────────────────────────────────────────────────────────────────
    async getCourses({ forceRefresh = false } = {}) {
      if (!forceRefresh && courseCache.data && Date.now() - courseCache.ts < CACHE_TTL) {
        return { kind: 'ok', courses: courseCache.data };
      }

      const r = await retry(
        () => dulmsGet(client, '/Registered/GetStudentResiterationCourses', {
          GradeStatusIds:            '0,1,2,3,4,5',
          GroupsIds:                 '-1',
          IsVirtualRegisteration:    'false',
        }),
        { label: 'courses', attempts: 2 }
      );

      if (r.kind !== 'ok') return r;
      if (!Array.isArray(r.data)) return { kind: 'structural' };

      const courses = r.data.map(c => ({
        id:     String(c.CourseId),
        code:   c.Code  || '',
        name:   c.Name  || '',
        status: c.GradeStatusId,
        group:  c.GrpName,
      }));

      courseCache = { ts: Date.now(), data: courses };
      return { kind: 'ok', courses };
    },

    // ─────────────────────────────────────────────────────────────────
    //  getCourseSchedule — مجموعات مادة
    // ─────────────────────────────────────────────────────────────────
    async getCourseSchedule(courseId) {
      const r = await retry(
        () => dulmsGet(client, '/Registered/GetCourseSchedual', { CourseId: courseId }),
        { label: 'schedule', attempts: 2 }
      );

      if (r.kind !== 'ok') return r;
      if (!Array.isArray(r.data)) return { kind: 'structural' };

      const groups = {};

      for (const item of r.data) {
        if (!item || item.Type !== 'Group') continue;
        const gid = item.GroupId;
        if (gid == null) continue;

        if (!groups[gid]) {
          const rawName   = String(item.GroupName || '').trim();
          const shortName = String(item.ShortName || '').trim();
          const isUni     = !!item.IsUniversity;

          let displayName;
          if (isUni && shortName && rawName) displayName = `${shortName}-${rawName}`;
          else if (rawName) displayName = rawName;
          else if (shortName) displayName = `${shortName}-${gid}`;
          else displayName = `Group-${gid}`;

          groups[gid] = {
            id:            gid,
            name:          displayName,
            rawName,
            shortName,
            isUniversity:  isUni,
            blocked:       !!item.IsBlocked,
            total:         parseInt(item.StudentsCount)   || 0,
            registered:    parseInt(item.RegisteredCount) || 0,
            slots:         [],
          };
        }

        groups[gid].slots.push({
          day:   item.DayWeekName,
          time:  item.Time,
          hall:  item.ClassRoomName,
          staff: item.Staff,
        });
      }

      const list = Object.values(groups).map(g => ({
        ...g,
        seats:     g.total - g.registered,
        available: !g.blocked && (g.total - g.registered) > 0,
      }));

      return { kind: 'ok', groups: list };
    },

    // ─────────────────────────────────────────────────────────────────
    //  getRegInfo — معلومات التسجيل
    // ─────────────────────────────────────────────────────────────────
    async getRegInfo() {
      return retry(
        () => dulmsPost(client, '/Registered/GetStudentResiterationInfo'),
        { label: 'regInfo', attempts: 2 }
      );
    },

    // ─────────────────────────────────────────────────────────────────
    //  getStudentTable — جدول الطالب (المحاضرات)
    // ─────────────────────────────────────────────────────────────────
    async getStudentTable() {
      return retry(
        () => dulmsPost(client, '/Registered/GetStudentTable'),
        { label: 'studentTable', attempts: 2 }
      );
    },

    // ─────────────────────────────────────────────────────────────────
    //  getAllIntervals — mapping IntervalId → وقت
    // ─────────────────────────────────────────────────────────────────
    async getAllIntervals() {
      return retry(
        () => dulmsPost(client, '/Registered/GetAllIntervals'),
        { label: 'intervals', attempts: 2 }
      );
    },

    // ─────────────────────────────────────────────────────────────────
    //  resolveTargetId — يحل كود مادة لكائن كامل
    // ─────────────────────────────────────────────────────────────────
    async resolveTargetId(query, { onlyRegisterable = true } = {}) {
      const r = await this.getCourses({ forceRefresh: true });
      if (r.kind !== 'ok') return null;

      const pool = onlyRegisterable
        ? r.courses.filter(c => _isRegisterable(c.status))
        : r.courses;

      const qNorm = normalizeCode(query);
      const qRaw  = String(query).toUpperCase().trim();
      const qNoSp = qRaw.replace(/\s+/g, '');

      return (
        pool.find(c => normalizeCode(c.code) === qNorm) ||
        pool.find(c => String(c.code).toUpperCase().trim() === qRaw) ||
        pool.find(c => normalizeCode(c.code).includes(qNorm)) ||
        pool.find(c => String(c.name).toUpperCase().includes(qRaw)) ||
        pool.find(c => String(c.name).toUpperCase().replace(/\s+/g, '').includes(qNoSp)) ||
        null
      );
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════
module.exports = {
  makeApi,
};
