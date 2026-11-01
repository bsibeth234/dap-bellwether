/**
 * A D1 compatible facade over Node's built in SQLite.
 *
 * This exists so the tests exercise the real schema and the real SQL rather
 * than a mock that agrees with whatever the code happens to do. If a query is
 * malformed or an upsert is wrong, these tests fail here rather than in
 * production against D1.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new Statement(this.db, this.sql, args);
  }

  async first() {
    const row = this.db.prepare(this.sql).get(...this.args);
    return row === undefined ? null : row;
  }

  async all() {
    return { results: this.db.prepare(this.sql).all(...this.args), success: true };
  }

  async run() {
    const info = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(info.changes) } };
  }
}

export class TestD1 {
  /** @param {string} [schemaFile] schema.sql for the bellwether database, licences.sql for dap-licences */
  constructor(schemaFile = 'schema.sql') {
    this.db = new DatabaseSync(':memory:');
    const schema = readFileSync(join(here, '..', schemaFile), 'utf8');
    this.db.exec(schema);
  }

  prepare(sql) {
    return new Statement(this.db, sql);
  }

  /** Like D1, a batch is one transaction: if a statement fails, none of them is kept. */
  async batch(statements) {
    const out = [];
    this.db.exec('BEGIN');
    try {
      for (const statement of statements) {
        out.push(await statement.run());
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return out;
  }
}
