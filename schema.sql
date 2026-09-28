DROP DATABASE IF EXISTS grades;
CREATE DATABASE grades;

-- Beoordelingssysteem eindexamens — databaseschema (SQLite)
-- ---------------------------------------------------------------------------
-- Kern van het model:
--   * een EXAMEN hoort bij een VAK (bijv. Wiskunde B, havo, 2025-2026)
--   * een examen bestaat uit meerdere EXAMENONDERDELEN (SE, CE, praktijk, ...)
--   * elk onderdeel heeft een eigen WEGING in procenten (weight_percent)
--   * per STUDENT wordt per onderdeel een CIJFER vastgelegd
--   * het EINDCIJFER = som(weging x cijfer) / som(weging), afgerond op 1 decimaal
--
-- De som van de wegingen van alle onderdelen van één examen mag niet boven
-- 100% uitkomen (afgedwongen met triggers). Een eindcijfer is pas "definitief"
-- als de wegingen samen precies 100% zijn en alle cijfers zijn ingevuld.
-- ---------------------------------------------------------------------------

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1. Vakken
-- ---------------------------------------------------------------------------
CREATE TABLE subjects (
  id         INTEGER PRIMARY KEY,
  code       TEXT    NOT NULL UNIQUE,          -- 'WISB'
  name       TEXT    NOT NULL,                 -- 'Wiskunde B'
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- 2. Eindexamens (één examen per vak / niveau / schooljaar)
-- ---------------------------------------------------------------------------
CREATE TABLE exams (
  id          INTEGER PRIMARY KEY,
  subject_id  INTEGER NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  title       TEXT    NOT NULL,
  school_year TEXT    NOT NULL,                     -- '2025-2026'
  level       TEXT    NOT NULL CHECK (level IN ('vmbo-tl', 'havo', 'vwo')),
  pass_mark   REAL    NOT NULL DEFAULT 5.5 CHECK (pass_mark BETWEEN 1 AND 10),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (subject_id, school_year, level)
);

-- ---------------------------------------------------------------------------
-- 3. Examenonderdelen met instelbare weging
--    weight_percent is de weging van dit onderdeel in het eindcijfer.
-- ---------------------------------------------------------------------------
CREATE TABLE exam_components (
  id             INTEGER PRIMARY KEY,
  exam_id        INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  code           TEXT    NOT NULL,                 -- 'CE', 'SE1'
  name           TEXT    NOT NULL,                 -- 'Centraal examen'
  component_type TEXT    NOT NULL CHECK (component_type IN
                   ('schoolexamen', 'centraal_examen', 'praktijk', 'mondeling', 'portfolio')),
  weight_percent REAL    NOT NULL CHECK (weight_percent > 0 AND weight_percent <= 100),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (exam_id, code)
);

CREATE INDEX IF NOT EXISTS idx_exam_components_exam ON exam_components(exam_id);

-- ---------------------------------------------------------------------------
-- 4. Studenten
-- ---------------------------------------------------------------------------
CREATE TABLE students (
  id             INTEGER PRIMARY KEY,
  student_number TEXT NOT NULL UNIQUE,
  full_name      TEXT NOT NULL,
  email          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- 5. Inschrijving: welke student doet welk examen
-- ---------------------------------------------------------------------------
CREATE TABLE enrollments (
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  exam_id     INTEGER NOT NULL REFERENCES exams(id)    ON DELETE CASCADE,
  enrolled_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (student_id, exam_id)
);

-- ---------------------------------------------------------------------------
-- 6. Resultaten: cijfer per student per examenonderdeel
--    grade mag NULL zijn → onderdeel is nog niet nagekeken (voorlopig cijfer)
-- ---------------------------------------------------------------------------
CREATE TABLE component_results (
  id           INTEGER PRIMARY KEY,
  component_id INTEGER NOT NULL REFERENCES exam_components(id) ON DELETE CASCADE,
  student_id   INTEGER NOT NULL REFERENCES students(id)         ON DELETE CASCADE,
  grade        REAL    CHECK (grade IS NULL OR (grade >= 1 AND grade <= 10)),
  comment      TEXT,
  graded_at    TEXT,
  UNIQUE (component_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_component_results_student ON component_results(student_id);

-- ---------------------------------------------------------------------------
-- 7. Bedrijfsregels: som van de wegingen mag nooit boven 100% uitkomen
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_component_weight_cap_insert
BEFORE INSERT ON exam_components
FOR EACH ROW
WHEN (SELECT COALESCE(SUM(weight_percent), 0) FROM exam_components WHERE exam_id = NEW.exam_id)
     + NEW.weight_percent > 100.000001
BEGIN
  SELECT RAISE(ABORT, 'De som van de wegingen van dit examen mag niet boven 100% uitkomen.');
END;

CREATE TRIGGER IF NOT EXISTS trg_component_weight_cap_update
BEFORE UPDATE OF weight_percent, exam_id ON exam_components
FOR EACH ROW
WHEN (SELECT COALESCE(SUM(weight_percent), 0) FROM exam_components
        WHERE exam_id = NEW.exam_id AND id <> OLD.id)
     + NEW.weight_percent > 100.000001
BEGIN
  SELECT RAISE(ABORT, 'De som van de wegingen van dit examen mag niet boven 100% uitkomen.');
END;

-- Houd graded_at automatisch bij de laatste cijferwijziging.
CREATE TRIGGER IF NOT EXISTS trg_component_results_stamp_insert
AFTER INSERT ON component_results
FOR EACH ROW WHEN NEW.grade IS NOT NULL AND NEW.graded_at IS NULL
BEGIN
  UPDATE component_results SET graded_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_component_results_stamp_update
AFTER UPDATE OF grade ON component_results
FOR EACH ROW WHEN NEW.grade IS NOT OLD.grade
BEGIN
  UPDATE component_results
     SET graded_at = CASE WHEN NEW.grade IS NULL THEN NULL ELSE datetime('now') END
   WHERE id = NEW.id;
END;

-- ---------------------------------------------------------------------------
-- 8. Views — hier gebeurt de automatische berekening van het eindcijfer
-- ---------------------------------------------------------------------------

-- 8a. Overzicht van de weging per examen (is de weging compleet?).
CREATE VIEW IF NOT EXISTS exam_weight_summary AS
SELECT
  e.id                                                 AS exam_id,
  e.title                                              AS title,
  sub.name                                             AS subject,
  sub.code                                             AS subject_code,
  e.school_year                                        AS school_year,
  e.level                                              AS level,
  e.pass_mark                                          AS pass_mark,
  COUNT(c.id)                                          AS component_count,
  ROUND(COALESCE(SUM(c.weight_percent), 0), 2)         AS total_weight,
  CASE WHEN ABS(COALESCE(SUM(c.weight_percent), 0) - 100) < 0.000001
       THEN 1 ELSE 0 END                               AS weights_complete,
  ROUND(100 - COALESCE(SUM(c.weight_percent), 0), 2)   AS remaining_weight
FROM exams e
JOIN subjects sub ON sub.id = e.subject_id
LEFT JOIN exam_components c ON c.exam_id = e.id
GROUP BY e.id;

-- 8b. Cijfer x weging per student per onderdeel (bouwsteen voor het eindcijfer).
CREATE VIEW IF NOT EXISTS student_component_scores AS
SELECT
  en.student_id      AS student_id,
  c.exam_id          AS exam_id,
  c.id               AS component_id,
  c.code             AS component_code,
  c.name             AS component_name,
  c.component_type   AS component_type,
  c.weight_percent   AS weight_percent,
  r.grade            AS grade,
  CASE WHEN r.grade IS NULL THEN NULL
       ELSE ROUND(c.weight_percent * r.grade, 4) END AS weighted_points
FROM enrollments en
JOIN exam_components c ON c.exam_id = en.exam_id
LEFT JOIN component_results r
       ON r.component_id = c.id AND r.student_id = en.student_id;

-- 8c. Het automatisch berekende eindcijfer per student per examen.
--     final_grade = som(weging x cijfer) / som(weging van de ingevulde cijfers)
--     is_complete = alle cijfers ingevuld EN de wegingen samen 100%
CREATE VIEW IF NOT EXISTS student_final_grades AS
SELECT
  sc.student_id                                                 AS student_id,
  sc.exam_id                                                    AS exam_id,
  COUNT(*)                                                      AS component_count,
  COUNT(sc.grade)                                               AS graded_count,
  ROUND(COALESCE(SUM(sc.weight_percent), 0), 2)                 AS total_weight,
  ROUND(COALESCE(SUM(CASE WHEN sc.grade IS NOT NULL
                          THEN sc.weight_percent END), 0), 2)   AS graded_weight,
  ROUND(COALESCE(SUM(sc.weighted_points), 0), 4)                AS weighted_points,
  ROUND(COALESCE(SUM(sc.weighted_points), 0)
        / NULLIF(SUM(CASE WHEN sc.grade IS NOT NULL
                          THEN sc.weight_percent END), 0), 4)   AS weighted_average,
  ROUND(COALESCE(SUM(sc.weighted_points), 0)
        / NULLIF(SUM(CASE WHEN sc.grade IS NOT NULL
                          THEN sc.weight_percent END), 0), 1)   AS final_grade,
  CASE WHEN COUNT(sc.grade) = COUNT(*)
        AND ABS(COALESCE(SUM(sc.weight_percent), 0) - 100) < 0.000001
       THEN 1 ELSE 0 END                                        AS is_complete
FROM student_component_scores sc
GROUP BY sc.student_id, sc.exam_id;

-- 8d. Rapportage: eindcijfer + geslaagd/gezakt, met de namen erbij.
CREATE VIEW IF NOT EXISTS student_exam_overview AS
SELECT
  st.student_number                             AS student_number,
  st.full_name                                  AS full_name,
  sub.name                                      AS subject,
  e.title                                       AS exam_title,
  e.school_year                                 AS school_year,
  e.level                                       AS level,
  g.student_id                                  AS student_id,
  g.exam_id                                     AS exam_id,
  g.component_count                             AS component_count,
  g.graded_count                                AS graded_count,
  g.total_weight                                AS total_weight,
  g.graded_weight                               AS graded_weight,
  g.weighted_average                            AS weighted_average,
  g.final_grade                                 AS final_grade,
  g.is_complete                                 AS is_complete,
  e.pass_mark                                   AS pass_mark,
  CASE WHEN g.is_complete = 1 AND g.final_grade >= e.pass_mark THEN 1
       WHEN g.is_complete = 1                                  THEN 0
       ELSE NULL END                            AS passed
FROM student_final_grades g
JOIN students  st  ON st.id  = g.student_id
JOIN exams     e   ON e.id   = g.exam_id
JOIN subjects  sub ON sub.id = e.subject_id;
