import { describe, expect, it } from 'vitest';
import { BotDb } from './botDb';

describe('BotDb', () => {
  it('runs a schema once per key and reuses prepared statements', () => {
    const db = new BotDb(':memory:');
    db.ensureSchema('t', 'CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, v TEXT)');
    db.ensureSchema('t', 'this is not SQL — never executed because the key was already applied');
    db.stmt('INSERT INTO t (k, v) VALUES (?, ?)').run('a', '1');
    expect(db.stmt('SELECT v FROM t WHERE k = ?').get('a')).toEqual({ v: '1' });
    expect(db.stmt('SELECT v FROM t WHERE k = ?')).toBe(db.stmt('SELECT v FROM t WHERE k = ?'));
  });

  it('rolls a transaction back when it throws', () => {
    const db = new BotDb(':memory:');
    db.ensureSchema('t', 'CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY)');
    expect(() =>
      db.transaction(() => {
        db.stmt('INSERT INTO t (k) VALUES (?)').run('x');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.stmt('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 0 });
  });
});
