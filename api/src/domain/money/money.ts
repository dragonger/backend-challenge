import { Decimal } from 'decimal.js';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from '../errors/domain-error.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

/** numeric(20,2) holds 18 integer digits; larger values are rejected up front (400, never a 500 from the database). */
export const MAX_INTEGER_DIGITS = 18;
// 0 or 1..18 integer digits without leading zero, optional 1-2 fraction digits.
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})(\.\d{1,2})?$/;
const LIMIT = new Decimal(10).pow(MAX_INTEGER_DIGITS);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Immutable monetary value with fixed scale 2.
 *
 * Input contract: a plain non-negative decimal string with at most 2 fraction
 * digits ("10", "10.5" and "10.50" are accepted and normalized to "10.50").
 * NaN, Infinity, scientific notation, blanks, signs, extra fraction digits and
 * more than 18 integer digits (the numeric(20,2) capacity) are rejected. Negative values only exist as results of arithmetic.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (
      props === null ||
      typeof props !== 'object' ||
      typeof props.amount !== 'string' ||
      !AMOUNT_PATTERN.test(props.amount)
    ) {
      throw new InvalidMoneyError('Invalid monetary amount');
    }

    if (
      typeof props.currency !== 'string' ||
      !CURRENCY_PATTERN.test(props.currency)
    ) {
      throw new InvalidMoneyError('Invalid currency');
    }

    return new Money(new Decimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    const sum = this.value.plus(other.value);

    if (sum.abs().greaterThanOrEqualTo(LIMIT)) {
      throw new InvalidMoneyError('Amount exceeds the supported range');
    }

    return new Money(sum, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError();
    }
  }
}
