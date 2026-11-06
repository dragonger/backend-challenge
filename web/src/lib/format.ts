import type { Money } from '../api/client';

/**
 * Formats a money value for display by manipulating the decimal STRING only
 * (no Number, no float math). "1000.5" -> "R$ 1.000,50".
 */
export function formatMoney(money: Money): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(money.amount);

  if (!match) {
    return `${money.currency} ${money.amount}`;
  }

  const sign = match[1] ?? '';
  const integer = match[2] ?? '0';
  const fraction = (match[3] ?? '').padEnd(2, '0');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const prefix = money.currency === 'BRL' ? 'R$' : money.currency;

  return `${sign}${prefix} ${grouped},${fraction}`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);

  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('pt-BR');
}

export function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export const newUuid = (): string => crypto.randomUUID();

export const newExternalId = (): string => `ext-${crypto.randomUUID().slice(0, 8)}`;

export const newRoundId = (): string => `round-${crypto.randomUUID().slice(0, 6)}`;
