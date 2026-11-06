import { expect } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';

/**
 * Global financial invariants, checked in SQL against whatever is in the
 * database. Called at the end of every integration test.
 *
 *  1. wallet.balance == sum(credits) - sum(debits) of its ledger, balance >= 0
 *  2. every ledger entry chains: balance_before == previous balance_after
 *  3. with a ledger, last balance_after == wallet.balance
 *  4. wallet.version == 1 + number of non-OPENING ledger entries
 *  5. PROCESSED balance-affecting transactions have exactly one ledger entry;
 *     REJECTED / FAILED / PENDING* / LOSS have none
 */
export async function assertLedgerInvariant(em: EntityManager): Promise<void> {
  const mismatches = await em.execute<Array<{ id: string }>>(`
    select w.id
      from wallets w
      left join wallet_ledger_entries l on l.wallet_id = w.id
     group by w.id, w.balance
    having w.balance <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)
        or w.balance < 0
  `);
  expect(mismatches).toEqual([]);

  const brokenChain = await em.execute<Array<{ wallet_id: string }>>(`
    select wallet_id from (
      select wallet_id, balance_before,
             lag(balance_after, 1, 0::numeric) over (partition by wallet_id order by sequence) as previous_after
        from wallet_ledger_entries
    ) t
    where balance_before <> previous_after
  `);
  expect(brokenChain).toEqual([]);

  const lastAfter = await em.execute<Array<{ id: string }>>(`
    select w.id from wallets w
     where exists (select 1 from wallet_ledger_entries l where l.wallet_id = w.id)
       and w.balance <> (select l.balance_after from wallet_ledger_entries l
                          where l.wallet_id = w.id order by l.sequence desc limit 1)
  `);
  expect(lastAfter).toEqual([]);

  const badVersion = await em.execute<Array<{ id: string }>>(`
    select w.id from wallets w
     where w.version <> 1 + (
       select count(*) from wallet_ledger_entries l
         join wager_transactions t on t.id = l.transaction_id
        where l.wallet_id = w.id and t.kind <> 'OPENING')
  `);
  expect(badVersion).toEqual([]);

  const badLedgerLink = await em.execute<Array<{ id: string }>>(`
    select t.id from wager_transactions t
     where (
       (t.status = 'PROCESSED' and t.kind <> 'LOSS'
         and (select count(*) from wallet_ledger_entries l where l.transaction_id = t.id) <> 1)
       or ((t.status <> 'PROCESSED' or t.kind = 'LOSS')
         and exists (select 1 from wallet_ledger_entries l where l.transaction_id = t.id))
     )
  `);
  expect(badLedgerLink).toEqual([]);
}
