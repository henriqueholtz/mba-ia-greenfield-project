import { randomBytes } from 'crypto';

const SLUG_LENGTH = 8;

export function generateSlug(): string {
  return randomBytes(Math.ceil((SLUG_LENGTH * 6) / 8))
    .toString('base64url')
    .slice(0, SLUG_LENGTH);
}
