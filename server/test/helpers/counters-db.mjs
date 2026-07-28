// server/test/helpers/counters-db.mjs — shared direct-SQL seeding for the T5
// counters db (api-stats / stats / stats-payload / control-routes suites).
//
// The DDL + upsert below DELIBERATELY hand-pin the one real writer's schema
// (server/lib/capture-events.mjs, spec §6 column order) instead of importing
// it: the pin is what makes accidental writer schema drift fail loudly in the
// readers' tests. Seeding goes through direct SQL at all because
// recordCaptureEvent hardcodes day=today — historical rows can't come from
// the writer.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// UTC day string — the writer's day convention. Computed per call so a row
// that omits `day` means "today" even across a UTC-midnight boundary.
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

export function seedCountersDb(dbPath, rows = []) {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS counters (
        day     TEXT    NOT NULL,
        surface TEXT    NOT NULL,
        project TEXT    NOT NULL,
        event   TEXT    NOT NULL,
        outcome TEXT    NOT NULL,
        count   INTEGER NOT NULL,
        PRIMARY KEY (day, surface, project, event, outcome)
      )
    `);
    db.pragma('user_version = 1');
    const stmt = db.prepare(`
      INSERT INTO counters (day, surface, project, event, outcome, count)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (day, surface, project, event, outcome)
      DO UPDATE SET count = count + excluded.count
    `);
    for (const r of rows) {
      stmt.run(r.day ?? todayUtc(), r.surface ?? 'claude-code', r.project ?? '', r.event, r.outcome ?? '', r.count ?? 1);
    }
  } finally {
    db.close();
  }
}
