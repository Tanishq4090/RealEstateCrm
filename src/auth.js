// Dashboard sign-in. The password crosses the network once, at login. After that the
// browser holds a random session id in a cookie that page scripts cannot read.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

const COOKIE = 'pr_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const MAX_TRACKED = 1000;

const sha = (s) => createHash('sha256').update(String(s)).digest();
export const same = (a, b) => timingSafeEqual(sha(a), sha(b));
export const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https';

function sessionCookie(req, value, maxAgeSeconds) {
  return [`${COOKIE}=${value}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAgeSeconds}`, ...(isHttps(req) ? ['Secure'] : [])].join('; ');
}

function readCookie(req) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === COOKIE) return value;
  }
  return null;
}

/**
 * Cloudflare's visitor header is only trusted where Cloudflare sets it: the tunnel on this machine, or Render,
 * whose proxy is the peer for everyone. X-Forwarded-For is never used, because visitors can send their own.
 */
function clientIp(req) {
  const peer = req.socket?.remoteAddress ?? '';
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
  return ((local || process.env.RENDER === 'true' || process.env.VERCEL === '1') && (req.headers['x-real-ip'] || req.headers['cf-connecting-ip'])) || peer;
}

export function createAuth() {
  const sessions = new Map(); // sha256 of the session id -> expiry, so a memory dump holds no usable id
  const revoked = new Set();
  const failures = new Map(); // ip -> { count, until }
  const key = (token) => sha(token).toString('hex');
  const signPayload = (payload) => createHmac('sha256', `session:${config.dashboardPassword}`).update(payload).digest('hex');
  const verifyStateless = (token) => {
    if (process.env.VERCEL !== '1' || revoked.has(key(token))) return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [expStr, nonce, sig] = parts;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp <= Date.now()) return false;
    return same(sig, signPayload(`${expStr}.${nonce}`));
  };

  return {
    isSignedIn(req) {
      if (!config.dashboardPassword) return true;
      const token = readCookie(req);
      if (!token) return false;
      const expires = sessions.get(key(token));
      if (expires) {
        if (expires > Date.now()) return true;
        sessions.delete(key(token));
        return false;
      }
      return verifyStateless(token);
    },

    /** Returns { status, cookie }. Five wrong passwords lock that visitor out for 15 minutes. */
    signIn(req, password) {
      const ip = clientIp(req);
      const seen = failures.get(ip);
      if (seen?.until > Date.now()) return { status: 429 };
      if (!config.dashboardPassword || !same(password ?? '', config.dashboardPassword)) {
        if (failures.size >= MAX_TRACKED) failures.clear();
        const count = (seen?.count ?? 0) + 1;
        failures.set(ip, { count, until: count >= MAX_FAILURES ? Date.now() + LOCK_MS : 0 });
        return { status: 401 };
      }
      failures.delete(ip);
      const exp = Date.now() + SESSION_MS;
      const token = process.env.VERCEL === '1'
        ? (() => { const p = `${exp}.${randomBytes(16).toString('hex')}`; return `${p}.${signPayload(p)}`; })()
        : randomBytes(32).toString('hex');
      sessions.set(key(token), exp);
      return { status: 200, cookie: sessionCookie(req, token, SESSION_MS / 1000) };
    },

    signOut(req) {
      const token = readCookie(req);
      if (token) {
        sessions.delete(key(token));
        if (process.env.VERCEL === '1') revoked.add(key(token));
      }
      return sessionCookie(req, '', 0);
    },
  };
}
