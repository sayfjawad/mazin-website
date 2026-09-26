'use strict';
// Tests voor de rekenlogica, het databaseschema (wegingen/views/triggers)
// en de REST-API. Draaien met: npm test

// De server moet de testdatabase in het geheugen gebruiken, niet data/grades.db.
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

const grades = require('../grades');
const { openDatabase, seedDatabase } = require('../db');

// ---------------------------------------------------------------------------
// Rekenlogica
// ---------------------------------------------------------------------------
test('round rondt af op één decimaal (halve waarden naar boven)', () => {
  assert.equal(grades.round(7.45, 1), 7.5);
  assert.equal(grades.round(5.4499, 1), 5.4);
  assert.equal(grades.round(6.0, 1), 6.0);
  assert.equal(grades.round(null), null);
});

test('parseGrade accepteert komma en punt en weigert ongeldige cijfers', () => {
  assert.equal(grades.parseGrade('5,5'), 5.5);
  assert.equal(grades.parseGrade(' 7.25 '), 7.3);
  assert.equal(grades.parseGrade(''), null);
  assert.equal(grades.parseGrade(null), null);
  assert.throws(() => grades.parseGrade('11'), /tussen 1 en 10/);
  assert.throws(() => grades.parseGrade('onvoldoende'), /tussen 1 en 10/);
});

test('parseWeight weigert wegingen buiten 0–100', () => {
  assert.equal(grades.parseWeight('33,33'), 33.33);
  assert.throws(() => grades.parseWeight('0'), /tussen 0 en 100/);
  assert.throws(() => grades.parseWeight('101'), /tussen 0 en 100/);
});

test('eindcijfer = som(weging x cijfer) / som(weging), afgerond op 1 decimaal', () => {
  const wiskundeAmina = [
    { weight_percent: 20, grade: 7.5 },
    { weight_percent: 20, grade: 8.0 },
    { weight_percent: 10, grade: 8.5 },
    { weight_percent: 50, grade: 7.0 },
  ];
  const result = grades.calculateFinalGrade(wiskundeAmina, { passMark: 5.5 });
  assert.equal(result.totalWeight, 100);
  assert.equal(result.weightedPoints, 745);
  assert.equal(result.weightedAverage, 7.45);
  assert.equal(result.finalGrade, 7.5);
  assert.equal(result.isComplete, true);
  assert.equal(result.passed, true);
});

test('eindcijfer is voorlopig zolang niet alle cijfers bekend zijn', () => {
  const zonderCE = [
    { weight_percent: 20, grade: 7.0 },
    { weight_percent: 20, grade: 7.5 },
    { weight_percent: 10, grade: 8.0 },
    { weight_percent: 50, grade: null },
  ];
  const result = grades.calculateFinalGrade(zonderCE, { passMark: 5.5 });
  assert.equal(result.gradedWeight, 50);
  assert.equal(result.finalGrade, 7.4);
  assert.equal(result.isComplete, false);
  assert.equal(result.passed, null);
});

test('een cijfer onder de cesuur geeft onvoldoende', () => {
  const bram = [
    { weight_percent: 20, grade: 5.5 },
    { weight_percent: 20, grade: 6.0 },
    { weight_percent: 10, grade: 7.0 },
    { weight_percent: 50, grade: 5.0 },
  ];
  const result = grades.calculateFinalGrade(bram, { passMark: 5.5 });
  assert.equal(result.finalGrade, 5.5);
  assert.equal(result.passed, true);
  const strenger = grades.calculateFinalGrade(bram, { passMark: 6.0 });
  assert.equal(strenger.passed, false);
});

test('validateWeights controleert of de wegingen samen 100% zijn', () => {
  assert.deepEqual(grades.validateWeights([{ weight_percent: 30 }, { weight_percent: 70 }]), {
    totalWeight: 100, remainingWeight: 0, isComplete: true, exceedsMaximum: false,
  });
  const teWeinig = grades.validateWeights([{ weight_percent: 30 }, { weight_percent: 20 }]);
  assert.equal(teWeinig.isComplete, false);
  assert.equal(teWeinig.remainingWeight, 50);
});

// ---------------------------------------------------------------------------
// Database: schema, triggers en views
// ---------------------------------------------------------------------------
function seededDb() {
  const db = openDatabase(':memory:');
  seedDatabase(db);
  return db;
}

test('seed vult een volledig examen met wegingen die samen 100% zijn', () => {
  const db = seededDb();
  const exam = db.prepare('SELECT * FROM exam_weight_summary WHERE exam_id = 1').get();
  assert.equal(exam.total_weight, 100);
  assert.equal(exam.weights_complete, 1);
  assert.equal(exam.component_count, 4);
});

test('trigger blokkeert een weging waardoor de som boven 100% komt', () => {
  const db = seededDb();
  assert.throws(
    () => db.prepare('UPDATE exam_components SET weight_percent = 30 WHERE id = 1').run(),
    /niet boven 100/
  );
  // Verlagen mag, en daarna mag een ander onderdeel het verschil opvullen tot 100%.
  db.prepare('UPDATE exam_components SET weight_percent = 15 WHERE id = 2').run();
  db.prepare('UPDATE exam_components SET weight_percent = 25 WHERE id = 1').run();
  const summary = db.prepare('SELECT * FROM exam_weight_summary WHERE exam_id = 1').get();
  assert.equal(summary.total_weight, 100);
  assert.equal(summary.weights_complete, 1);
});

test('view student_exam_overview berekent het eindcijfer automatisch', () => {
  const db = seededDb();
  const amina = db.prepare(
    "SELECT * FROM student_exam_overview WHERE full_name = 'Amina Yilmaz' AND subject = 'Wiskunde B'"
  ).get();
  assert.equal(amina.final_grade, 7.5);
  assert.equal(amina.is_complete, 1);
  assert.equal(amina.passed, 1);

  const eva = db.prepare(
    "SELECT * FROM student_exam_overview WHERE full_name = 'Eva Jansen' AND subject = 'Wiskunde B'"
  ).get();
  assert.equal(eva.final_grade, 7.4);
  assert.equal(eva.graded_weight, 50);
  assert.equal(eva.is_complete, 0);
  assert.equal(eva.passed, null);

  // De view en de JS-rekenlogica moeten hetzelfde eindcijfer geven.
  const components = db.prepare(
    'SELECT weight_percent, (SELECT grade FROM component_results r WHERE r.component_id = c.id AND r.student_id = ?) AS grade FROM exam_components c WHERE exam_id = 1'
  ).all(eva.student_id);
  assert.equal(grades.calculateFinalGrade(components, { passMark: 5.5 }).finalGrade, eva.final_grade);
});

test('een cijfer buiten 1–10 wordt door de database geweigerd', () => {
  const db = seededDb();
  assert.throws(
    () => db.prepare('UPDATE component_results SET grade = 12 WHERE id = 1').run(),
    /CHECK constraint failed/
  );
});
