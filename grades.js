'use strict';
// Pure rekenlogica voor het beoordelingssysteem.
// Geen database- of frameworkafhankelijkheid: hierdoor goed te testen en
// overal te hergebruiken (API, rapportage, tests).

const WEIGHT_TOLERANCE = 1e-6; // tolerantie waarmee we 100% vergelijken

/** Rondt af op `decimals` decimalen (halve waarden naar boven, examenstandaard). */
function round(value, decimals = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  const factor = 10 ** decimals;
  const scaled = Number((Number(value) * factor).toPrecision(12));
  return Math.round(scaled) / factor;
}

/** Leest het gewicht uit een record: `weight_percent` of `weight`. */
function weightOf(entry) {
  const value = entry.weight_percent ?? entry.weight;
  return Number(value);
}

/** Zet invoer om naar een geldig cijfer (1 t/m 10), of null. Gooit bij ongeldige invoer. */
function parseGrade(input) {
  if (input === null || input === undefined || input === '') return null;
  const normalised = String(input).trim().replace(',', '.');
  const grade = Number(normalised);
  if (!Number.isFinite(grade) || grade < 1 || grade > 10) {
    throw new Error(`Ongeldig cijfer "${input}": een cijfer ligt tussen 1 en 10.`);
  }
  return round(grade, 1);
}

/** Zet invoer om naar een geldig wegingpercentage (> 0 t/m 100). */
function parseWeight(input) {
  const weight = Number(String(input).trim().replace(',', '.'));
  if (!Number.isFinite(weight) || weight <= 0 || weight > 100) {
    throw new Error(`Ongeldige weging "${input}": de weging ligt tussen 0 en 100.`);
  }
  return round(weight, 2);
}

/**
 * Berekent het eindcijfer op basis van examenonderdelen met weging.
 * @param {Array<{weight_percent?: number, weight?: number, grade?: number|null}>} components
 * @param {{passMark?: number}} [options]
 * @returns {{
 *   componentCount: number, gradedCount: number,
 *   totalWeight: number, gradedWeight: number,
 *   weightedPoints: number, weightedAverage: number|null, finalGrade: number|null,
 *   isComplete: boolean, passed: boolean|null
 * }}
 */
function calculateFinalGrade(components, options = {}) {
  const passMark = Number(options.passMark ?? 5.5);
  const list = Array.isArray(components) ? components : [];

  let totalWeight = 0;
  let gradedWeight = 0;
  let weightedPoints = 0;
  let gradedCount = 0;

  for (const component of list) {
    const weight = weightOf(component);
    if (!Number.isFinite(weight)) continue;
    totalWeight += weight;
    const grade = component.grade;
    if (grade === null || grade === undefined) continue;
    gradedWeight += weight;
    weightedPoints += weight * Number(grade);
    gradedCount += 1;
  }

  const weightsComplete = Math.abs(totalWeight - 100) < WEIGHT_TOLERANCE;
  const isComplete = list.length > 0 && gradedCount === list.length && weightsComplete;
  const finalGrade = gradedWeight > 0 ? round(weightedPoints / gradedWeight, 1) : null;

  return {
    componentCount: list.length,
    gradedCount,
    totalWeight: round(totalWeight, 2),
    gradedWeight: round(gradedWeight, 2),
    weightedPoints: round(weightedPoints, 4),
    weightedAverage: gradedWeight > 0 ? round(weightedPoints / gradedWeight, 4) : null,
    finalGrade,
    isComplete,
    passed: isComplete && finalGrade !== null ? finalGrade >= passMark : null,
  };
}

/**
 * Controleert de wegingen van een examen.
 * De som mag nooit boven 100% en moet precies 100% zijn voor een definitief cijfer.
 */
function validateWeights(components) {
  const totalWeight = (Array.isArray(components) ? components : [])
    .reduce((sum, component) => sum + weightOf(component), 0);
  const rounded = round(totalWeight, 2);
  return {
    totalWeight: rounded,
    remainingWeight: round(100 - totalWeight, 2),
    isComplete: Math.abs(totalWeight - 100) < WEIGHT_TOLERANCE,
    exceedsMaximum: totalWeight > 100 + WEIGHT_TOLERANCE,
  };
}

module.exports = {
  WEIGHT_TOLERANCE,
  round,
  parseGrade,
  parseWeight,
  calculateFinalGrade,
  validateWeights,
};
