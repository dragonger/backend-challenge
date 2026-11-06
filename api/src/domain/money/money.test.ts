
import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../errors/domain-error.js';
import { Money } from './money.js';

describe('Money', () => {
  test('creates a monetary value', () => {
    const money = Money.from({
      amount: '25.00',
      currency: 'BRL',
    });

    expect(money.toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
  });

  test('adds values precisely', () => {
    const a = Money.from({ amount: '0.10', currency: 'BRL' });
    const b = Money.from({ amount: '0.20', currency: 'BRL' });

    expect(a.add(b).toString()).toBe('0.30 BRL');
  });

  test('subtracts values precisely', () => {
    const a = Money.from({ amount: '100.00', currency: 'BRL' });
    const b = Money.from({ amount: '80.00', currency: 'BRL' });

    expect(a.subtract(b).toString()).toBe('20.00 BRL');
  });

  test('does not mutate the original value', () => {
    const original = Money.from({
      amount: '100.00',
      currency: 'BRL',
    });

    const result = original.subtract(
      Money.from({ amount: '30.00', currency: 'BRL' }),
    );

    expect(original.toString()).toBe('100.00 BRL');
    expect(result.toString()).toBe('70.00 BRL');
  });

  test('rejects operations between different currencies', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow('Currency mismatch');
  });

  test.each([
    '-10.00',
    '1.234',
    'NaN',
    'Infinity',
    '1e3',
    '',
    ' 10.00',
  ])('rejects invalid input: %s', (amount: string) => {
    expect(() =>
      Money.from({ amount, currency: 'BRL' }),
    ).toThrow('Invalid monetary amount');
  });

  test('supports negative results internally', () => {
    const a = Money.from({ amount: '20.00', currency: 'BRL' });
    const b = Money.from({ amount: '30.00', currency: 'BRL' });

    expect(a.subtract(b).toJSON().amount).toBe('-10.00');
  });

  test('compares monetary values', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '20.00', currency: 'BRL' });

    expect(a.isLessThan(b)).toBe(true);
    expect(a.equals(b)).toBe(false);
    expect(Money.zero('BRL').isZero()).toBe(true);
  });

  test('zero is neither positive nor negative', () => {
    const zero = Money.zero('BRL');

    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
  });
});

describe('Money normalization and contracts', () => {
  test.each([
    ['10', '10.00'],
    ['10.5', '10.50'],
    ['0', '0.00'],
    ['0.05', '0.05'],
    ['1000000.99', '1000000.99'],
  ])('normalizes %s to scale 2', (input, expected) => {
    expect(Money.from({ amount: input, currency: 'BRL' }).toJSON().amount).toBe(
      expected,
    );
  });

  test.each(['007', '.5', '5.', '+5', '1,00', '0x10', '1 000', '1.00\n'])(
    'rejects malformed amount %p',
    (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    },
  );

  test('accepts the largest supported amount and rejects one more integer digit', () => {
    const max = '999999999999999999.99';

    expect(Money.from({ amount: max, currency: 'BRL' }).toJSON().amount).toBe(max);
    expect(() =>
      Money.from({ amount: '1000000000000000000.00', currency: 'BRL' }),
    ).toThrow(InvalidMoneyError);
  });

  test('refuses an addition that would overflow numeric(20,2)', () => {
    const max = Money.from({ amount: '999999999999999999.99', currency: 'BRL' });

    expect(() => max.add(Money.from({ amount: '0.01', currency: 'BRL' }))).toThrow(
      InvalidMoneyError,
    );
  });

  test('rejects non-string amounts (numbers never represent money)', () => {
    expect(() =>
      Money.from({ amount: 10 as unknown as string, currency: 'BRL' }),
    ).toThrow(InvalidMoneyError);
  });

  test.each(['brl', 'BR', 'BRLL', '', 'B1L'])(
    'rejects invalid currency %p',
    (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(
        'Invalid currency',
      );
    },
  );

  test('currency conflicts raise a domain error in every operation', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl.equals(usd)).toBe(false);
  });

  test('addition does not suffer from binary floating point', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 10; i += 1) {
      total = total.add(Money.from({ amount: '0.10', currency: 'BRL' }));
    }
    expect(total.toString()).toBe('1.00 BRL');
  });
});
