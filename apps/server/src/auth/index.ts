/**
 * Username + password auth.
 *
 * Play money is still a password people reuse, so this is not treated as a toy:
 * argon2id hashing, opaque session tokens stored only as a hash, httpOnly +
 * SameSite cookies, and no password or token ever reaching a log line.
 */

import { hash, verify } from '@node-rs/argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { STARTING_CHIPS } from '@websino/engine';

import type { Db } from '../db/index.js';
import { applyLedger } from '../db/ledger.js';

export const SESSION_COOKIE = 'websino_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class AuthError extends Error {}

export interface User {
  id: string;
  username: string;
}

/** Sessions are stored hashed, so a database leak does not hand over live sessions. */
const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export function validateUsername(username: string): string {
  const trimmed = username.trim();
  if (trimmed.length < 3 || trimmed.length > 20) {
    throw new AuthError('username must be 3-20 characters');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new AuthError('username may only contain letters, numbers, _ and -');
  }
  return trimmed;
}

export function validatePassword(password: string): void {
  if (password.length < 8) throw new AuthError('password must be at least 8 characters');
  if (password.length > 200) throw new AuthError('password is too long');
}

export async function register(db: Db, username: string, password: string): Promise<User> {
  const clean = validateUsername(username);
  validatePassword(password);

  const existing = db
    .prepare('SELECT id FROM users WHERE username_lower = ?')
    .get(clean.toLowerCase());
  if (existing) throw new AuthError('that username is taken');

  const id = randomUUID();
  const now = Date.now();
  const passwordHash = await hash(password);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO users (id, username, username_lower, password_hash, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, clean, clean.toLowerCase(), passwordHash, now, now);
    db.prepare(
      'INSERT INTO wallets (user_id, chips, peak_chips, updated_at) VALUES (?, 0, 0, ?)',
    ).run(id, now);
  })();

  // Starting chips arrive through the ledger like everything else, so the audit
  // balances from the very first row.
  applyLedger(db, id, [{ delta: STARTING_CHIPS, reason: 'signup' }]);

  return { id, username: clean };
}

export async function login(db: Db, username: string, password: string): Promise<User> {
  const row = db
    .prepare('SELECT id, username, password_hash FROM users WHERE username_lower = ?')
    .get(username.trim().toLowerCase()) as
    | { id: string; username: string; password_hash: string }
    | undefined;

  // Verify against a dummy hash when the user is missing, so a wrong username and a
  // wrong password take the same time and cannot be told apart.
  const stored = row?.password_hash ?? (await hash('websino-timing-equalizer'));
  const ok = await verify(stored, password).catch(() => false);
  if (!row || !ok) throw new AuthError('wrong username or password');

  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), row.id);
  return { id: row.id, username: row.username };
}

export function createSession(db: Db, userId: string): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(hashToken(token), userId, now, expiresAt);
  return { token, expiresAt };
}

export function resolveSession(db: Db, token: string | undefined): User | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, s.expires_at AS expiresAt
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(hashToken(token)) as { id: string; username: string; expiresAt: number } | undefined;

  if (!row) return null;
  if (row.expiresAt < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  return { id: row.id, username: row.username };
}

export function destroySession(db: Db, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}
