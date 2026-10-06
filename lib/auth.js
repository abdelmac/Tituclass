import { randomBytes, scrypt, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const hash = value => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await derive(password, salt, 64)).toString('hex')}`;
}
export async function passwordMatches(password, stored) {
  const [salt, value] = stored.split(':');
  const actual = await derive(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(value, 'hex'));
}
export function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
export function text(value, label, max = 500, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, `Check ${label}.`);
  return value.trim();
}
export function credentials(body) {
  const email = text(body.email, 'email', 254, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
  if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) fail(400, 'Use a password between 12 and 128 characters.');
  return { email, password: body.password };
}
