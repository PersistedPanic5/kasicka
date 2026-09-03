import { supabase } from '@/lib/supabase';

/**
 * Shared "split with someone(s)" logic — used by both
 * components/ExpenseEntryForm.tsx (split while logging a brand-new
 * expense) and app/(app)/transactions.tsx (split off an already-existing
 * transaction). The two screens have different save lifecycles (the entry
 * form creates the transaction and the debts together in one Save; the
 * transactions screen already has a transaction_id and saves the split on
 * its own separate button) so each keeps its own local state/JSX for the
 * people list, but both go through the functions here for id generation,
 * the "split evenly" math, and — the part most worth not duplicating —
 * actually creating the `debts` rows one by one, per Pavel's "It should
 * then create record one by one."
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

/** Creates one `debts` row per valid person, sequentially (one by one, not
 * Promise.all) — Pavel asked for records to be created one by one, and
 * sequential inserts also make a partial-failure error message ("saved 3
 * of 5") unambiguous about which ones actually went through. */
export async function createDebtsForSplit(params: {
  ownerId: string;
  transactionId: string;
  targetAccountId: string;
  message: string | null;
  people: { name: string; amount: number }[];
}): Promise<CreateSplitDebtsResult> {
  const links: { name: string; token: string }[] = [];
  const failures: string[] = [];

  for (const person of params.people) {
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
