import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientBalanceError,
  InvalidAmountError,
  InvalidLedgerEntryError,
  InvalidWalletError,
} from '../errors/domain-error.js';
import { Money } from '../money/money.js';
import { Wallet } from './wallet.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00.000Z');

const open = (balance = '100.00'): Wallet =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(balance),
    now: at,
  });

const movement = (amount: string, entryId = 'entry-1') => ({
  entryId,
  transactionId: 'tx-1',
  money: brl(amount),
  at,
});

describe('Wallet', () => {
  test('opens with initial balance and version 1', () => {
    const wallet = open();

    expect(wallet.balance.toString()).toBe('100.00 BRL');
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.playerId).toBe('player-1');
  });

  test('credit returns a balanced ledger entry and bumps the version', () => {
    const wallet = open();

    const entry = wallet.credit(movement('50.00'));

    expect(wallet.balance.toString()).toBe('150.00 BRL');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toString()).toBe('100.00 BRL');
    expect(entry.balanceAfter.toString()).toBe('150.00 BRL');
    expect(entry.isBalanced()).toBe(true);
  });

  test('debit returns a balanced ledger entry and bumps the version', () => {
    const wallet = open();

    const entry = wallet.debit(movement('30.00'));

    expect(wallet.balance.toString()).toBe('70.00 BRL');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceAfter.toString()).toBe('70.00 BRL');
  });

  test('allows debit of the exact balance', () => {
    const wallet = open();

    wallet.debit(movement('100.00'));

    expect(wallet.balance.isZero()).toBe(true);
  });

  test('insufficient balance fails without changing balance or version', () => {
    const wallet = open();

    expect(() => wallet.debit(movement('150.00'))).toThrow(
      InsufficientBalanceError,
    );

    expect(wallet.balance.toString()).toBe('100.00 BRL');
    expect(wallet.version).toBe(1);
  });

  test('version only increments when the balance changes', () => {
    const wallet = open();

    expect(() => wallet.debit(movement('500.00'))).toThrow();
    expect(() => wallet.credit(movement('0.00'))).toThrow();
    expect(wallet.version).toBe(1);

    wallet.credit(movement('1.00'));
    wallet.debit(movement('1.00', 'entry-2'));
    expect(wallet.version).toBe(3);
  });

  test('rejects negative initial balance and empty ids', () => {
    expect(() =>
      Wallet.open({
        id: 'w',
        playerId: 'p',
        initialBalance: brl('10.00').negate(),
      }),
    ).toThrow(InvalidWalletError);

    expect(() =>
      Wallet.open({ id: ' ', playerId: 'p', initialBalance: brl('1.00') }),
    ).toThrow(InvalidWalletError);
  });

  test('rejects zero-value operations', () => {
    const wallet = open();

    expect(() => wallet.credit(movement('0.00'))).toThrow(InvalidAmountError);
    expect(() => wallet.debit(movement('0.00'))).toThrow(InvalidAmountError);
  });

  test('rejects different currencies', () => {
    const wallet = open();
    const usd = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => wallet.credit({ ...movement('1.00'), money: usd })).toThrow(
      CurrencyMismatchError,
    );
    expect(() => wallet.debit({ ...movement('1.00'), money: usd })).toThrow(
      CurrencyMismatchError,
    );
  });

  test('rehydrate does not revalidate', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('5.00').negate(),
      version: 9,
      createdAt: at,
      updatedAt: at,
    });

    expect(wallet.version).toBe(9);
    expect(wallet.balance.isNegative()).toBe(true);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e1',
    walletId: 'w1',
    transactionId: 't1',
    createdAt: at,
  };

  test('create validates the arithmetic', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('85.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('is structurally immutable', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('10.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('10.00'),
    });

    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { id: string }).id = 'other';
    }).toThrow();
  });
});
