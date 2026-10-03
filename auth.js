import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { database } from './database.js';

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = 'janice_session';
const SESSION_DAYS = 7;

export async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = await scrypt(password, Buffer.from(salt, 'hex'), 64);
  return { salt, hash: Buffer.from(hash).toString('hex') };
}

export async function verifyPassword(password, salt, expectedHash) {
  try {
    const candidate = Buffer.from(await scrypt(password, Buffer.from(salt, 'hex'), 64));
    const expected = Buffer.from(expectedHash, 'hex');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function readCookie(request, name) {
  const prefix = `${name}=`;
  const entry = (request.headers.cookie || '').split(';').map((value) => value.trim()).find((value) => value.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : '';
}

export function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

export function createSession(userId, response) {
  const token = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  database.prepare('INSERT INTO sessions (token_hash, csrf_token, user_id, expires_at) VALUES (?, ?, ?, ?)').run(hashSessionToken(token), csrfToken, userId, expiresAt);
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
  });
  return csrfToken;
}

export function destroySession(request, response) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashSessionToken(token));
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/'
  });
}

export function getSession(request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const session = database.prepare(`SELECT s.token_hash, s.csrf_token, s.expires_at, u.id, u.email, u.name, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > datetime('now')`).get(hashSessionToken(token));
  if (!session) return null;
  return { user: publicUser(session), csrfToken: session.csrf_token, sessionHash: session.token_hash };
}

export function requireAuth(request, response, next) {
  const session = getSession(request);
  if (!session) return response.status(401).json({ error: 'Authentication required.' });
  request.auth = session;
  next();
}

export function requireCsrf(request, response, next) {
  const supplied = request.get('x-csrf-token') || '';
  const expected = request.auth?.csrfToken || '';
  if (!supplied || !expected || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return response.status(403).json({ error: 'Invalid security token. Refresh the page and try again.' });
  }
  next();
}

export function requireRole(role) {
  return (request, response, next) => {
    if (request.auth?.user.role !== role) return response.status(403).json({ error: 'This account does not have permission for this action.' });
    next();
  };
}

export const adminOnly = [requireAuth, requireRole('admin')];
export const tenantOnly = [requireAuth, requireRole('tenant')];
export const writeAdmin = [...adminOnly, requireCsrf];
export const writeTenant = [...tenantOnly, requireCsrf];

export function emailIsValid(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
