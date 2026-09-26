'use strict';
// Beoordelingssysteem eindexamens — HTTP-server (zero dependencies).
// Serveert de webapp op 0.0.0.0:3000 (nginx zet dit door naar mazin.sdai.nl)
// en biedt een kleine REST-API op /api/* waarmee je wegingen en cijfers beheert.
// Draaien: node server.js   (of: npm run dev)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { openSeededDatabase } = require('./db');
const { calculateFinalGrade, validateWeights, parseGrade, parseWeight } = require('./grades');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const db = openSeededDatabase();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        reject(new HttpError(413, 'Verzoek is te groot.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'Ongeldige JSON in het verzoek.'));
      }
    });
    req.on('error', reject);
  });
}

function required(value, field) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new HttpError(400, `Veld "${field}" is verplicht.`);
  }
  return String(value).trim();
}

const LEVELS = ['vmbo-tl', 'havo', 'vwo'];
const COMPONENT_TYPES = ['schoolexamen', 'centraal_examen', 'praktijk', 'mondeling', 'portfolio'];

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
const q = {
  listSubjects: () => db.prepare('SELECT * FROM subjects ORDER BY name').all(),
  insertSubject: (code, name) =>
    db.prepare('INSERT INTO subjects (code, name) VALUES (?, ?)').run(code, name),

  listStudents: () => db.prepare('SELECT * FROM students ORDER BY full_name').all(),
  insertStudent: (number, name, email) =>
    db.prepare('INSERT INTO students (student_number, full_name, email) VALUES (?, ?, ?)')
      .run(number, name, email || null),

  listExams: () =>
    db.prepare('SELECT * FROM exam_weight_summary ORDER BY subject, school_year').all(),
  getExam: (id) =>
    db.prepare(
      `SELECT e.*, sub.name AS subject, sub.code AS subject_code FROM exams e
       JOIN subjects sub ON sub.id = e.subject_id WHERE e.id = ?`
    ).get(id),
  insertExam: (subjectId, title, schoolYear, level, passMark) =>
    db.prepare(
      `INSERT INTO exams (subject_id, title, school_year, level, pass_mark)
       VALUES (?, ?, ?, ?, ?)`
    ).run(subjectId, title, schoolYear, level, passMark),
  updateExam: (id, fields) => {
    const allowed = ['title', 'school_year', 'level', 'pass_mark'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k) && fields[k] !== undefined);
    if (!keys.length) throw new HttpError(400, 'Geen geldige velden om bij te werken.');
    const setClause = keys.map((k) => `${k} = ?`).join(', ');
    return db.prepare(`UPDATE exams SET ${setClause} WHERE id = ?`)
      .run(...keys.map((k) => fields[k]), id);
  },

  listComponents: (examId) =>
    db.prepare('SELECT * FROM exam_components WHERE exam_id = ? ORDER BY sort_order, id').all(examId),
  getComponent: (id) => db.prepare('SELECT * FROM exam_components WHERE id = ?').get(id),
  insertComponent: (examId, code, name, type, weight, order) =>
    db.prepare(
      `INSERT INTO exam_components (exam_id, code, name, component_type, weight_percent, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(examId, code, name, type, weight, order),
  updateComponent: (id, fields) => {
    const allowed = ['code', 'name', 'component_type', 'weight_percent', 'sort_order'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k) && fields[k] !== undefined);
    if (!keys.length) throw new HttpError(400, 'Geen geldige velden om bij te werken.');
    const setClause = keys.map((k) => `${k} = ?`).join(', ');
    return db.prepare(`UPDATE exam_components SET ${setClause} WHERE id = ?`)
      .run(...keys.map((k) => fields[k]), id);
  },
  deleteComponent: (id) => db.prepare('DELETE FROM exam_components WHERE id = ?').run(id),

  enrolledStudents: (examId) =>
    db.prepare(
      `SELECT st.* FROM enrollments en JOIN students st ON st.id = en.student_id
       WHERE en.exam_id = ? ORDER BY st.full_name`
    ).all(examId),
  isEnrolled: (examId, studentId) =>
    !!db.prepare('SELECT 1 AS ok FROM enrollments WHERE exam_id = ? AND student_id = ?')
      .get(examId, studentId),
  enroll: (examId, studentId) =>
    db.prepare('INSERT OR IGNORE INTO enrollments (student_id, exam_id) VALUES (?, ?)')
      .run(studentId, examId),

  resultsForExam: (examId) =>
    db.prepare(
      `SELECT r.component_id, r.student_id, r.grade FROM component_results r
       JOIN exam_components c ON c.id = r.component_id WHERE c.exam_id = ?`
    ).all(examId),
  upsertResult: (componentId, studentId, grade) => {
    const existing = db
      .prepare('SELECT id FROM component_results WHERE component_id = ? AND student_id = ?')
      .get(componentId, studentId);
    if (grade === null) {
      if (existing) db.prepare('DELETE FROM component_results WHERE id = ?').run(existing.id);
      return;
    }
    if (existing) {
      db.prepare('UPDATE component_results SET grade = ? WHERE id = ?').run(grade, existing.id);
    } else {
      db.prepare('INSERT INTO component_results (component_id, student_id, grade) VALUES (?, ?, ?)')
        .run(componentId, studentId, grade);
    }
  },

  report: (examId) =>
    examId
      ? db.prepare('SELECT * FROM student_exam_overview WHERE exam_id = ? ORDER BY full_name').all(examId)
      : db.prepare('SELECT * FROM student_exam_overview ORDER BY subject, full_name').all(),
};

// ---------------------------------------------------------------------------
// Samengestelde responses
// ---------------------------------------------------------------------------
function getExamOr404(examId) {
  const exam = q.getExam(examId);
  if (!exam) throw new HttpError(404, `Examen ${examId} niet gevonden.`);
  return exam;
}

function getComponentOr404(componentId) {
  const component = q.getComponent(componentId);
  if (!component) throw new HttpError(404, `Examenonderdeel ${componentId} niet gevonden.`);
  return component;
}

/** Examen met onderdelen en de controle op de totale weging. */
function examDetail(examId) {
  const exam = getExamOr404(examId);
  const components = q.listComponents(examId);
  return { exam, components, weight: validateWeights(components) };
}

/** Bouwt het cijferrooster (studenten x onderdelen) inclusief berekend eindcijfer. */
function examGrid(examId) {
  const exam = getExamOr404(examId);
  const components = q.listComponents(examId);
  const students = q.enrolledStudents(examId);
  const results = q.resultsForExam(examId);

  const gradeByStudentComponent = new Map(
    results.map((r) => [`${r.student_id}:${r.component_id}`, r.grade])
  );

  const rows = students.map((student) => {
    const grades = {};
    const entries = components.map((component) => {
      const grade = gradeByStudentComponent.get(`${student.id}:${component.id}`) ?? null;
      grades[component.id] = grade;
      return { weight_percent: component.weight_percent, grade };
    });
    return {
      student_id: student.id,
      student_number: student.student_number,
      full_name: student.full_name,
      grades,
      calculation: calculateFinalGrade(entries, { passMark: exam.pass_mark }),
    };
  });

  return { exam, components, weight: validateWeights(components), rows };
}

// ---------------------------------------------------------------------------
// API-routes: [methode, pad-patroon, handler]
// ---------------------------------------------------------------------------
const routes = [
  ['GET', /^\/api\/subjects$/, () => ({ subjects: q.listSubjects() })],
  ['POST', /^\/api\/subjects$/, ({ body }) => {
    const code = required(body.code, 'code').toUpperCase();
    const name = required(body.name, 'name');
    const created = q.insertSubject(code, name);
    const subject = db.prepare('SELECT * FROM subjects WHERE id = ?')
      .get(Number(created.lastInsertRowid));
    return { status: 201, payload: { subject } };
  }],

  ['GET', /^\/api\/students$/, () => ({ students: q.listStudents() })],
  ['POST', /^\/api\/students$/, ({ body }) => {
    const number = required(body.student_number, 'student_number');
    const name = required(body.full_name, 'full_name');
    const created = q.insertStudent(number, name, body.email);
    const student = db.prepare('SELECT * FROM students WHERE id = ?')
      .get(Number(created.lastInsertRowid));
    return { status: 201, payload: { student } };
  }],

  ['GET', /^\/api\/exams$/, () => ({ exams: q.listExams() })],
  ['POST', /^\/api\/exams$/, ({ body }) => {
    const subjectId = Number(required(body.subject_id, 'subject_id'));
    const title = required(body.title, 'title');
    const schoolYear = required(body.school_year, 'school_year');
    const level = required(body.level, 'level');
    if (!LEVELS.includes(level)) {
      throw new HttpError(400, `Niveau moet één van ${LEVELS.join(', ')} zijn.`);
    }
    const passMark = body.pass_mark === undefined ? 5.5 : Number(body.pass_mark);
    if (!(passMark >= 1 && passMark <= 10)) {
      throw new HttpError(400, 'De cesuur ligt tussen 1 en 10.');
    }
    const created = q.insertExam(subjectId, title, schoolYear, level, passMark);
    return { status: 201, payload: examDetail(Number(created.lastInsertRowid)) };
  }],
  ['GET', /^\/api\/exams\/(\d+)$/, ({ params }) => examDetail(Number(params[0]))],
  ['PUT', /^\/api\/exams\/(\d+)$/, ({ params, body }) => {
    const examId = Number(params[0]);
    getExamOr404(examId);
    const fields = {};
    if (body.title !== undefined) fields.title = required(body.title, 'title');
    if (body.school_year !== undefined) fields.school_year = required(body.school_year, 'school_year');
    if (body.level !== undefined) {
      if (!LEVELS.includes(body.level)) {
        throw new HttpError(400, `Niveau moet één van ${LEVELS.join(', ')} zijn.`);
      }
      fields.level = body.level;
    }
    if (body.pass_mark !== undefined) {
      const passMark = Number(body.pass_mark);
      if (!(passMark >= 1 && passMark <= 10)) {
        throw new HttpError(400, 'De cesuur ligt tussen 1 en 10.');
      }
      fields.pass_mark = passMark;
    }
    q.updateExam(examId, fields);
    return examDetail(examId);
  }],

  ['POST', /^\/api\/exams\/(\d+)\/components$/, ({ params, body }) => {
    const examId = Number(params[0]);
    getExamOr404(examId);
    const code = required(body.code, 'code').toUpperCase();
    const name = required(body.name, 'name');
    const type = body.component_type || 'schoolexamen';
    if (!COMPONENT_TYPES.includes(type)) {
      throw new HttpError(400, `Type moet één van ${COMPONENT_TYPES.join(', ')} zijn.`);
    }
    const weight = parseWeight(required(body.weight_percent, 'weight_percent'));
    const nextOrder = db
      .prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM exam_components WHERE exam_id = ?')
      .get(examId).max_order + 1;
    const order = body.sort_order === undefined ? nextOrder : Number(body.sort_order);
    const created = q.insertComponent(examId, code, name, type, weight, order);
    const component = q.getComponent(Number(created.lastInsertRowid));
    return { status: 201, payload: { component, ...examDetail(examId) } };
  }],

  ['PUT', /^\/api\/components\/(\d+)$/, ({ params, body }) => {
    const componentId = Number(params[0]);
    const current = getComponentOr404(componentId);
    const fields = {};
    if (body.code !== undefined) fields.code = required(body.code, 'code').toUpperCase();
    if (body.name !== undefined) fields.name = required(body.name, 'name');
    if (body.component_type !== undefined) {
      if (!COMPONENT_TYPES.includes(body.component_type)) {
        throw new HttpError(400, `Type moet één van ${COMPONENT_TYPES.join(', ')} zijn.`);
      }
      fields.component_type = body.component_type;
    }
    if (body.weight_percent !== undefined) {
      fields.weight_percent = parseWeight(required(body.weight_percent, 'weight_percent'));
    }
    if (body.sort_order !== undefined) fields.sort_order = Number(body.sort_order);
    q.updateComponent(componentId, fields);
    return { component: q.getComponent(componentId), ...examDetail(current.exam_id) };
  }],

  ['DELETE', /^\/api\/components\/(\d+)$/, ({ params }) => {
    const componentId = Number(params[0]);
    const current = getComponentOr404(componentId);
    q.deleteComponent(componentId);
    return { deleted: componentId, ...examDetail(current.exam_id) };
  }],

  ['GET', /^\/api\/exams\/(\d+)\/grades$/, ({ params }) => examGrid(Number(params[0]))],
  ['PUT', /^\/api\/exams\/(\d+)\/grades$/, ({ params, body }) => {
    const examId = Number(params[0]);
    getExamOr404(examId);
    const studentId = Number(required(body.student_id, 'student_id'));
    const componentId = Number(required(body.component_id, 'component_id'));
    const component = getComponentOr404(componentId);
    if (component.exam_id !== examId) {
      throw new HttpError(400, `Onderdeel ${componentId} hoort niet bij examen ${examId}.`);
    }
    if (!q.isEnrolled(examId, studentId)) {
      throw new HttpError(400, `Student ${studentId} is niet ingeschreven voor examen ${examId}.`);
    }
    q.upsertResult(componentId, studentId, parseGrade(body.grade));
    return examGrid(examId);
  }],

  ['POST', /^\/api\/exams\/(\d+)\/enrollments$/, ({ params, body }) => {
    const examId = Number(params[0]);
    getExamOr404(examId);
    const studentId = Number(required(body.student_id, 'student_id'));
    q.enroll(examId, studentId);
    return { status: 201, payload: examGrid(examId) };
  }],

  ['GET', /^\/api\/report$/, ({ url }) => {
    const examId = url.searchParams.get('exam_id');
    return { report: q.report(examId ? Number(examId) : null) };
  }],
];

// ---------------------------------------------------------------------------
// Request-afhandeling
// ---------------------------------------------------------------------------
function toHttpError(error) {
  if (error instanceof HttpError) return error;
  const message = String((error && error.message) || 'Onbekende fout');
  if (/constraint|UNIQUE|FOREIGN KEY|mag niet boven|niet gevonden/i.test(message)) {
    return new HttpError(409, message);
  }
  return new HttpError(500, message);
}

const BODY_METHODS = ['POST', 'PUT', 'PATCH'];

async function handleApi(req, res, url) {
  for (const [method, pattern, handler] of routes) {
    if (!pattern.test(url.pathname)) continue;
    if (req.method !== method) continue;
    const body = BODY_METHODS.includes(req.method) ? await readJsonBody(req) : {};
    const params = pattern.exec(url.pathname).slice(1);
    const result = await handler({ req, res, params, body, url });
    const payload = result && result.payload !== undefined ? result.payload : result;
    const status = (result && result.status) || 200;
    return sendJson(res, status, payload);
  }
  if (routes.some(([, pattern]) => pattern.test(url.pathname))) {
    return sendJson(res, 405, { error: 'Methode niet toegestaan voor dit pad.' });
  }
  return sendJson(res, 404, { error: `Onbekend API-pad: ${url.pathname}` });
}

function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>404 — Not Found</h1>');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (error) {
      const httpError = toHttpError(error);
      if (httpError.status >= 500) console.error('[api]', error);
      sendJson(res, httpError.status, { error: httpError.message });
    }
    return;
  }
  serveStatic(res, url.pathname);
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () =>
    console.log(`beoordelingssysteem serving ${ROOT} on http://0.0.0.0:${PORT}`)
  );
}

module.exports = { server, app: { db, examGrid, examDetail, routes } };





