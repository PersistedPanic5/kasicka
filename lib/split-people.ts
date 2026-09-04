import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { buildMergedFromSnapshot, mergeDebtMessages } from '@/lib/debt-merge';
import type { MergedDebtSnapshot } from '@/types/database';

/**
 * Shared "split with someone(s)" logic — used by both
 * components/ExpenseEntryForm.tsx (split while logging a brand-new
 * expense) and app/(app)/transactions.tsx (split off an already-existing
 * transaction). The two screens have different save lifecycles (the entry
 * form creates the transaction and the debts together in one Save; the
 * transactions screen already has a transaction_id and saves the split on
 * its own separate button) so each keeps its own local state/JSX for the
 * people list, but both go through the functions here for id generation,
 * the "split evenly" math, the "merge with an existing outstanding debt"
 * offer (Pavel: "if I select the already existing person - offer me to
 * merge when confirming"), and — the part most worth not duplicating —
 * actually creating the `debts` rows, per Pavel's "It should then create
 * record one by one."
 */

export interface SplitPerson {
  id: string;
  name: string;
  amount: string;
}

let idCounter = 0;
/** Local, non-persisted row keys for the people list — never sent to the
 * database (each saved row gets its own real `debts.id` + share_token). */
export function newSplitPersonId(): string {
  idCounter += 1;
  return `split-${Date.now()}-${idCounter}`;
}

export function emptySplitPerson(): SplitPerson {
  return { id: newSplitPersonId(), name: '', amount: '' };
}

/** Rows with both a name and a positive amount — what actually gets saved. */
export function validSplitPeople(people: SplitPerson[]): { name: string; amount: number }[] {
  return people
    .map((p) => ({ name: p.name.trim(), amount: Number(p.amount) }))
    .filter((p) => p.name.length > 0 && Number.isFinite(p.amount) && p.amount > 0);
}

export function splitPeopleSum(people: SplitPerson[]): number {
  return validSplitPeople(people).reduce((sum, p) => sum + p.amount, 0);
}

/** Divides `total` evenly across every row in `people` (not just the valid
 * ones — an empty-name row still gets an amount filled in, since the point
 * is to save typing the number before typing the name). Distributes odd
 * cents to the first few people so the parts always sum back to exactly
 * `total` rather than drifting from repeated rounding. Re-running this
 * (Pavel: "recalculate and re-write if I change the amounts") always
 * starts fresh from `total` and the current person count — it's a pure
 * function, not something that accumulates state. */
export function splitEvenly(total: number, people: SplitPerson[]): SplitPerson[] {
  const n = people.length;
  if (n === 0 || !Number.isFinite(total) || total <= 0) return people;
  const totalCents = Math.round(total * 100);
  const baseCents = Math.floor(totalCents / n);
  const remainder = totalCents - baseCents * n;
  return people.map((p, i) => ({ ...p, amount: ((baseCents + (i < remainder ? 1 : 0)) / 100).toFixed(2) }));
}

export interface CreateSplitDebtsResult {
  links: { name: string; token: string }[];
  /** Set only if at least one insert failed — the successful ones (in
   * `links`) are still real, saved debts; this just means to tell the
   * person something went wrong partway through, not that nothing saved. */
  error: string | null;
}

/** A past debtor's single most recent OUTSTANDING debt — what "merge with
 * existing debt" offers to fold a new split amount into, instead of
 * creating yet another separate debt/link for someone who already has one
 * outstanding. See useDebtHistory() below. */
export interface OutstandingDebtMatch {
  id: string;
  owed_by_name: string;
  amount: number;
  message: string | null;
  transaction_id: string | null;
  target_account_id: string;
  merged_from: MergedDebtSnapshot[] | null;
}

export interface DebtHistory {
  /** Distinct names, most-recent-first, from ALL past debts (any status)
   * — feeds components/NameAutocompleteInput.tsx. Intentionally NOT
   * fuzzy-normalized/deduped beyond exact case-insensitive repeats: the
   * point is reducing "Maty" / "maty" / "Matty" drift, so this returns
   * the exact strings Pavel has actually typed before, and picking one
   * from the list is what keeps future entries consistent with past
   * ones. */
  pastNames: string[];
  /** Each name's single most recent OUTSTANDING debt, keyed by trimmed
   * lowercase name — feeds the "merge with existing debt" offer. A name
   * with no outstanding debt (or only CLAIMED_PAID/SETTLED ones) simply
   * isn't a key here. */
  outstandingByName: Map<string, OutstandingDebtMatch>;
}

/** One query serving both components/ExpenseEntryForm.tsx and
 * app/(app)/transactions.tsx — previously two separate concerns
 * (usePastDebtorNames() for autocomplete, nothing for merge-matching),
 * combined now that the merge offer needs full existing-debt rows, not
 * just names, and both screens want both. Capped at a generous 500
 * most-recent debt rows before de-duplicating, comfortably covering a
 * personal ledger's history without an unbounded query. */
export function useDebtHistory(): DebtHistory {
  const [history, setHistory] = useState<DebtHistory>({ pastNames: [], outstandingByName: new Map() });

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('debts')
      .select('id, owed_by_name, amount, message, status, transaction_id, target_account_id, merged_from, created_at')
      .order('created_at', { ascending: false })
      .limit(500)
      .then(({ data }) => {
        if (cancelled || !data) return;
        const seenNames = new Set<string>();
        const pastNames: string[] = [];
        const outstandingByName = new Map<string, OutstandingDebtMatch>();
        for (const row of data) {
          const trimmed = row.owed_by_name.trim();
          const key = trimmed.toLowerCase();
          if (!trimmed) continue;
          if (!seenNames.has(key)) {
            seenNames.add(key);
            pastNames.push(trimmed);
          }
          if (row.status === 'OUTSTANDING' && !outstandingByName.has(key)) {
            outstandingByName.set(key, {
              id: row.id,
              owed_by_name: trimmed,
              amount: Number(row.amount),
              message: row.message,
              transaction_id: row.transaction_id,
              target_account_id: row.target_account_id,
              merged_from: row.merged_from ?? null,
            });
          }
        }
        setHistory({ pastNames, outstandingByName });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return history;
}

export interface CreateOrMergeDebtsParams {
  ownerId: string;
  transactionId: string;
  targetAccountId: string;
  message: string | null;
  people: { name: string; amount: number }[];
  /** From useDebtHistory() — each name's existing OUTSTANDING debt, if any. */
  outstandingByName: Map<string, OutstandingDebtMatch>;
  /** Lowercased, trimmed names the person actually opted to merge (from
   * the merge-offer confirmation). A name present in `outstandingByName`
   * but NOT in this set still gets a brand-new, separate debt — merging
   * only ever happens when explicitly chosen. An empty set reproduces the
   * old "always create a new debt" behavior. */
  mergeNames: Set<string>;
  /** Localized currency label ("CZK"/"Kč") for the merged message's
   * amount tags — see lib/debt-merge.ts's mergeDebtMessages. */
  currencyLabel: string;
}

/** Creates one `debts` row per valid person — same as before, except a
 * person whose (trimmed, lowercased) name matches an existing OUTSTANDING
 * debt AND was opted into merging (`mergeNames`) gets folded into that
 * debt instead of creating another one: the existing row is replaced by
 * one new row with the combined amount/message and a `merged_from`
 * snapshot (so "Unmerge" on the Debts page can undo it) — this is the
 * direct fix for Pavel's "suddenly I have one person with like 3 bills and
 * I need to share 3 links with them". Sequential, one person at a time —
 * same reasoning as before: Pavel asked for records created one by one,
 * and it keeps a partial-failure message unambiguous about which ones
 * went through. */
export async function createOrMergeDebtsForSplit(params: CreateOrMergeDebtsParams): Promise<CreateSplitDebtsResult> {
  const links: { name: string; token: string }[] = [];
  const failures: string[] = [];
  // Guards against the same existing debt getting "consumed" twice if two
  // split people in this one save happen to share a name.
  const consumedExistingIds = new Set<string>();

  for (const person of params.people) {
    const key = person.name.trim().toLowerCase();
    const candidate = params.mergeNames.has(key) ? params.outstandingByName.get(key) : undefined;
    const existing = candidate && !consumedExistingIds.has(candidate.id) ? candidate : undefined;

    if (existing) {
      consumedExistingIds.add(existing.id);
      const mergedAmount = existing.amount + person.amount;
      const mergedMessage = mergeDebtMessages(
        [
          { message: existing.message, amount: existing.amount },
          { message: params.message, amount: person.amount },
        ],
        params.currencyLabel
      );

      const { data, error } = await supabase
        .from('debts')
        .insert({
          owner_id: params.ownerId,
          // No transaction_id -- this debt now combines the existing
          // debt's origin with this new split's, so it deliberately
          // points at neither (same reasoning as the Debts page's manual
          // merge -- see supabase/migrations/0009_debts_merge_support.sql).
          transaction_id: null,
          owed_by_name: existing.owed_by_name,
          amount: mergedAmount,
          target_account_id: params.targetAccountId,
          message: mergedMessage || null,
          merged_from: buildMergedFromSnapshot([
            {
              owed_by_name: existing.owed_by_name,
              amount: existing.amount,
              message: existing.message,
              transaction_id: existing.transaction_id,
              target_account_id: existing.target_account_id,
              merged_from: existing.merged_from,
            },
            {
              owed_by_name: person.name,
              amount: person.amount,
              message: params.message,
              transaction_id: params.transactionId,
              target_account_id: params.targetAccountId,
            },
          ]),
        })
        .select('share_token')
        .single();

      if (error) {
        failures.push(`${person.name}: ${error.message}`);
        continue;
      }
      // The old debt's own share link is gone the moment its row is
      // deleted -- the merge-offer copy in the UI says so up front.
      await supabase.from('debts').delete().eq('id', existing.id);
      if (data) links.push({ name: existing.owed_by_name, token: data.share_token });
      continue;
    }

    const { data, error } = await supabase
      .from('debts')
      .insert({
        owner_id: params.ownerId,
        transaction_id: params.transactionId,
        owed_by_name: person.name,
        amount: person.amount,
        target_account_id: params.targetAccountId,
        message: params.message,
      })
      .select('share_token')
      .single();

    if (error) {
      failures.push(`${person.name}: ${error.message}`);
    } else if (data) {
      links.push({ name: person.name, token: data.share_token });
    }
  }

  return { links, error: failures.length > 0 ? failures.join('; ') : null };
}
