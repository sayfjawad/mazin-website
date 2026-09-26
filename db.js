'use strict';
// Database-laag: opent de SQLite-database (node:sqlite, geen externe packages),
// draait schema.sql en vult bij een lege database voorbeelddata.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const DEFAULT_DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'grades.db');

/** Opent de database en zorgt dat het schema aanwezig is. */
function openDatabase(dbPath = DEFAULT_DB_PATH) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

function isEmpty(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM exams').get().n === 0;
}

/** Opent de database en seedt deze als er nog geen examens zijn. */
function openSeededDatabase(dbPath = DEFAULT_DB_PATH) {
  const db = openDatabase(dbPath);
  if (isEmpty(db)) seedDatabase(db);
  return db;
}

/** Vult de database met herkenbare voorbeelddata. */
function seedDatabase(db) {
  db.exec('BEGIN');
  try {
    const insertSubject = db.prepare('INSERT INTO subjects (code, name) VALUES (?, ?)');
    const subjects = [
      insertSubject.run('WISB', 'Wiskunde B').lastInsertRowid,
      insertSubject.run('NED', 'Nederlands').lastInsertRowid,
      insertSubject.run('ENG', 'Engels').lastInsertRowid,
    ].map(Number);

    const insertExam = db.prepare(
      `INSERT INTO exams (subject_id, title, school_year, level, pass_mark)
       VALUES (?, ?, ?, ?, ?)`
    );
    const exams = [
      Number(insertExam.run(subjects[0], 'Eindexamen Wiskunde B', '2025-2026', 'havo', 5.5).lastInsertRowid),
      Number(insertExam.run(subjects[1], 'Eindexamen Nederlands', '2025-2026', 'havo', 5.5).lastInsertRowid),
      Number(insertExam.run(subjects[2], 'Eindexamen Engels', '2025-2026', 'havo', 5.5).lastInsertRowid),
    ];

    const insertComponent = db.prepare(
      `INSERT INTO exam_components (exam_id, code, name, component_type, weight_percent, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    // exam_id, code, naam, type, weging(%), volgorde
    const components = [
      [exams[0], 'SE1', 'Schoolexamen periode 1', 'schoolexamen', 20, 1],
      [exams[0], 'SE2', 'Schoolexamen periode 2', 'schoolexamen', 20, 2],
      [exams[0], 'PO', 'Praktische opdracht', 'praktijk', 10, 3],
      [exams[0], 'CE', 'Centraal examen', 'centraal_examen', 50, 4],
      [exams[1], 'SE', 'Schoolexamen', 'schoolexamen', 30, 1],
      [exams[1], 'CE', 'Centraal examen', 'centraal_examen', 70, 2],
      [exams[2], 'SE', 'Schoolexamen', 'schoolexamen', 25, 1],
      [exams[2], 'MO', 'Mondeling', 'mondeling', 15, 2],
      [exams[2], 'CE', 'Centraal examen', 'centraal_examen', 60, 3],
    ];
    for (const c of components) insertComponent.run(...c);

    const insertStudent = db.prepare(
      'INSERT INTO students (student_number, full_name, email) VALUES (?, ?, ?)'
    );
    const studentNames = [
      ['2025001', 'Amina Yilmaz', 'a.yilmaz@school.example'],
      ['2025002', 'Bram de Vries', 'b.devries@school.example'],
      ['2025003', 'Chen Wei', 'c.wei@school.example'],
      ['2025004', 'Dilara Kaya', 'd.kaya@school.example'],
      ['2025005', 'Eva Jansen', 'e.jansen@school.example'],
    ];
    const students = studentNames.map((s) => Number(insertStudent.run(...s).lastInsertRowid));

    const enroll = db.prepare('INSERT INTO enrollments (student_id, exam_id) VALUES (?, ?)');
    for (const studentId of students) {
      for (const examId of exams) enroll.run(studentId, examId);
    }

    const insertResult = db.prepare(
      `INSERT INTO component_results (component_id, student_id, grade)
       VALUES (?, ?, ?)`
    );
    // De cijfers van Wiskunde B (examen 1). Eva heeft nog geen CE → voorlopig.
    const wiskunde = db
      .prepare('SELECT id FROM exam_components WHERE exam_id = ? ORDER BY sort_order')
      .all(exams[0])
      .map((row) => row.id);
    const wiskundeGrades = [
      // SE1, SE2, PO, CE
      [7.5, 8.0, 8.5, 7.0], // Amina
      [5.5, 6.0, 7.0, 5.0], // Bram  → 5.7 (onvoldoende)
      [9.0, 9.5, 9.0, 8.5], // Chen
      [6.0, 5.5, 8.0, 6.5], // Dilara
      [7.0, 7.5, 8.0, null], // Eva → nog geen CE, voorlopig 7.4
    ];
    wiskundeGrades.forEach((row, studentIndex) => {
      row.forEach((grade, componentIndex) => {
        insertResult.run(wiskunde[componentIndex], students[studentIndex], grade);
      });
    });

    // Nederlands en Engels: eerste twee studenten volledig, rest nog open.
    const ned = db
      .prepare('SELECT id FROM exam_components WHERE exam_id = ? ORDER BY sort_order')
      .all(exams[1])
      .map((row) => row.id);
    insertResult.run(ned[0], students[0], 6.5);
    insertResult.run(ned[1], students[0], 7.0);
    insertResult.run(ned[0], students[1], 5.0);
    insertResult.run(ned[1], students[1], 5.5);

    const eng = db
      .prepare('SELECT id FROM exam_components WHERE exam_id = ? ORDER BY sort_order')
      .all(exams[2])
      .map((row) => row.id);
    insertResult.run(eng[0], students[0], 8.0);
    insertResult.run(eng[1], students[0], 7.5);
    insertResult.run(eng[2], students[0], 8.0);

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return db;
}

module.exports = {
  openDatabase,
  openSeededDatabase,
  seedDatabase,
  isEmpty,
  DEFAULT_DB_PATH,
  SCHEMA_PATH,
};
