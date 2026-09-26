'use strict';
// Integratietests voor de REST-API: de server draait tegen een database in het
// geheugen, zodat de tests niets aanpassen in data/grades.db.

process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');

let base;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

async function call(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

const firstComponent = (detail, code) => detail.components.find((c) => c.code === code);
const studentRow = (grid, name) => grid.rows.find((row) => row.full_name === name);

test('GET /api/exams geeft de examens met hun totale weging terug', async () => {
  const { status, data } = await call('/api/exams');
  assert.equal(status, 200);
  assert.equal(data.exams.length, 3);
  const wiskunde = data.exams.find((exam) => exam.subject === 'Wiskunde B');
  assert.equal(wiskunde.total_weight, 100);
  assert.equal(wiskunde.weights_complete, 1);
});

test('GET /api/exams/:id/grades berekent eindcijfers en voorlopige cijfers', async () => {
  const { data } = await call('/api/exams/1/grades');
  assert.equal(data.components.length, 4);
  assert.equal(data.weight.totalWeight, 100);
  assert.equal(studentRow(data, 'Amina Yilmaz').calculation.finalGrade, 7.5);
  assert.equal(studentRow(data, 'Amina Yilmaz').calculation.passed, true);

  const eva = studentRow(data, 'Eva Jansen');
  assert.equal(eva.calculation.finalGrade, 7.4);
  assert.equal(eva.calculation.isComplete, false);
  assert.equal(eva.grades[firstComponent(data, 'CE').id], null);
});

test('PUT /api/exams/:id/grades vult een cijfer in en herberekent het eindcijfer', async () => {
  const detail = (await call('/api/exams/1')).data;
  const grid = (await call('/api/exams/1/grades')).data;
  const eva = studentRow(grid, 'Eva Jansen');

  const { status, data } = await call('/api/exams/1/grades', {
    method: 'PUT',
    body: {
      student_id: eva.student_id,
      component_id: firstComponent(detail, 'CE').id,
      grade: '6,0',
    },
  });

  assert.equal(status, 200);
  const updated = studentRow(data, 'Eva Jansen');
  assert.equal(updated.calculation.finalGrade, 6.7);
  assert.equal(updated.calculation.isComplete, true);
  assert.equal(updated.calculation.passed, true);
});

test('de API weigert een weging waardoor de som boven 100% komt', async () => {
  const detail = (await call('/api/exams/1')).data;
  const se1 = firstComponent(detail, 'SE1');

  const teHoog = await call(`/api/components/${se1.id}`, {
    method: 'PUT',
    body: { weight_percent: 30 },
  });
  assert.equal(teHoog.status, 409);
  assert.match(teHoog.data.error, /niet boven 100/);

  // Weging verlagen en een ander onderdeel compenseren mag wel.
  const omlaag = await call(`/api/components/${se1.id}`, {
    method: 'PUT',
    body: { weight_percent: 20 },
  });
  assert.equal(omlaag.status, 200);
  assert.equal(omlaag.data.weight.totalWeight, 100);
});

test('nieuwe onderdelen en wegingen zijn direct van invloed op het eindcijfer', async () => {
  const created = await call('/api/exams/1/components', {
    method: 'POST',
    body: { code: 'PO2', name: 'Praktische opdracht 2', component_type: 'praktijk', weight_percent: 25 },
  });
  assert.equal(created.status, 409, 'wegingen komen samen boven 100% uit');

  // Eerst SE2 verlagen van 20% naar 10%, dan past het nieuwe onderdeel wel.
  const detail = (await call('/api/exams/1')).data;
  await call(`/api/components/${firstComponent(detail, 'SE2').id}`, {
    method: 'PUT',
    body: { weight_percent: 10 },
  });
  const added = await call('/api/exams/1/components', {
    method: 'POST',
    body: { code: 'PO2', name: 'Praktische opdracht 2', component_type: 'praktijk', weight_percent: 10 },
  });
  assert.equal(added.status, 201);
  assert.equal(added.data.weight.totalWeight, 100);

  const grid = (await call('/api/exams/1/grades')).data;
  assert.equal(grid.components.length, 5);
  // Amina: nog geen cijfer voor PO2 → voorlopig, gewogen gemiddelde over 90%.
  const amina = studentRow(grid, 'Amina Yilmaz');
  assert.equal(amina.calculation.isComplete, false);
  assert.equal(amina.calculation.gradedWeight, 90);
});

test('GET /api/report geeft per student het eindcijfer uit de database-view', async () => {
  const { data } = await call('/api/report?exam_id=1');
  const amina = data.report.find((row) => row.full_name === 'Amina Yilmaz');
  assert.equal(amina.subject, 'Wiskunde B');
  assert.equal(typeof amina.final_grade, 'number');
  assert.equal(amina.is_complete, 0);
});

test('GET / levert de webapp en onbekende API-paden geven 404', async () => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Beoordelingssysteem eindexamens/);

  const missing = await call('/api/bestaat-niet');
  assert.equal(missing.status, 404);
});
