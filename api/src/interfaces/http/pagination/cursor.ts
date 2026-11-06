import { InvalidCursorError } from '../../../application/errors.js';

const VERSION = 'v1';
const PAYLOAD_PATTERN = /^v1:(\d{1,18})$/;

/**
 * Opaque pagination cursor: base64url of "v1:<ledger sequence>". Clients must
 * treat it as a black box, which lets the internal ordering change later (a new
 * version prefix) without breaking them.
 */
export function encodeCursor(sequence: string): string {
  return Buffer.from(`${VERSION}:${sequence}`, 'utf8').toString('base64url');
}

/** Returns the sequence inside the cursor or throws InvalidCursorError (HTTP 400). */
export function decodeCursor(cursor: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cursor)) {
    throw new InvalidCursorError();
  }

  const match = PAYLOAD_PATTERN.exec(Buffer.from(cursor, 'base64url').toString('utf8'));

  if (!match?.[1] || encodeCursor(match[1]) !== cursor) {
    throw new InvalidCursorError();
  }

  return match[1];
}
