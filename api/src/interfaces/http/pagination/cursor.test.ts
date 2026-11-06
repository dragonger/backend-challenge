import { describe, expect, test } from 'bun:test';
import { InvalidCursorError } from '../../../application/errors.js';
import { decodeCursor, encodeCursor } from './cursor.js';

describe('cursor', () => {
  test('round trip and opacity', () => {
    const cursor = encodeCursor('12345');

    expect(decodeCursor(cursor)).toBe('12345');
    expect(cursor).not.toContain('12345');
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test.each([
    '',
    '!!!',
    'not-a-cursor',
    Buffer.from('v2:10').toString('base64url'),
    Buffer.from('v1:abc').toString('base64url'),
    Buffer.from('v1:-5').toString('base64url'),
    Buffer.from('v1:1234567890123456789').toString('base64url'),
    `${encodeCursor('10')}=`,
    'a'.repeat(200),
  ])('rejects %p', (cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(InvalidCursorError);
  });
});
