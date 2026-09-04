import type { MergedDebtSnapshot } from '@/types/database';

/**
 * Shared logic for two places debts actually get merged: the Debts page's
 * "select two-or-more and merge" action (Pavel: "suddenly I have one
 * person with like 3 bills and I need to share 3 links with them" — see
 * app/(app)/debts.tsx), and the "merge with an existing outstanding debt"
 * offer shown at save time in components/ExpenseEntryForm.tsx and
 * app/(app)/transactions.tsx (Pavel's follow-up: "if I select the already
 * existing person - offer me to merge when confirming" — see
 * lib/split-people.ts's createOrMergeDebtsForSplit). Both combine several
 * debts into a single new one: amounts sum plainly, but the message and
 * the "what actually got folded in" history need more care.
 */

export interface MergeMessagePart {
  message: string | null | undefined;
  amount: number;
}

// lib/czech-qr-payment.ts's buildSpdPayload() truncates the SPD MSG field
// to 60 chars at encode time regardless — this mirrors that limit so the
// merge preview Pavel reviews before confirming already reflects what will
// actually end up on the QR code, rather than getting silently chopped
// later without him seeing it happen.
const QR_MESSAGE_LIMIT = 60;
const SEPARATOR = ' + ';

/**
 * Pavel's spec: "if it fits in the message, then fit in, if all texts
 * would be too long, then connect the beginnings of the messages and
 * shorten so we can fit into the QR code limit" — extended per his
 * follow-up to also carry each part's amount along with its text ("to the
 * merged text I want to include the texts + amounts so it's clear"). Each
 * part renders as "<text> (<amount> <currencyLabel>)", or just
 * "(<amount> <currencyLabel>)" when a part has no text — joined with " + "
 * if everything fits within the 60-char limit. Parts with neither a
 * message nor a positive amount are dropped rather than contributing
 * blank segments.
 */
export function mergeDebtMessages(parts: MergeMessagePart[], currencyLabel: string): string {
  const clean = parts
    .map((p) => ({ message: (p.message ?? '').trim(), amount: p.amount }))
    .filter((p) => p.message || p.amount > 0);
  if (clean.length === 0) return '';

  const amountTag = (amount: number) => `(${amount} ${currencyLabel})`;
  const full = clean.map((p) => (p.message ? `${p.message} ${amountTag(p.amount)}` : amountTag(p.amount)));
  const joined = full.join(SEPARATOR);
  if (joined.length <= QR_MESSAGE_LIMIT) return joined;

  // Doesn't fit whole — shorten each part's TEXT first (an amount tag is
  // short and, once space is tight, the more load-bearing half of the
  // two, since it's what tells the numbers apart), giving every part's
  // text an equal-ish share of whatever room is left once every amount
  // tag is accounted for.
  const tags = clean.map((p) => amountTag(p.amount));
  const separatorBudget = SEPARATOR.length * (clean.length - 1);
  // +1 per part for the space between its shortened text and its tag.
  const tagBudget = tags.reduce((sum, tag) => sum + tag.length + 1, 0);
  const textBudgetTotal = QR_MESSAGE_LIMIT - separatorBudget - tagBudget;

  if (textBudgetTotal >= clean.length) {
    const perTextBudget = Math.max(Math.floor(textBudgetTotal / clean.length), 1);
    const shortened = clean.map((p, i) => {
      if (!p.message) return tags[i];
      const text = p.message.length > perTextBudget ? `${p.message.slice(0, Math.max(perTextBudget - 1, 1))}…` : p.message;
      return `${text} ${tags[i]}`;
    });
    return shortened.join(SEPARATOR).slice(0, QR_MESSAGE_LIMIT);
  }

  // Even the amount tags alone don't comfortably leave room for any text
  // — drop the text entirely and just list the amounts, still joined and
  // hard-capped as a safety net so this can never silently exceed the
  // QR code's message limit.
  return tags.join(SEPARATOR).slice(0, QR_MESSAGE_LIMIT);
}

export interface MergedDebtSourceRow {
  owed_by_name: string;
  amount: number;
  message: string | null;
  transaction_id: string | null;
  target_account_id: string;
  /** Present when this source row was itself already a merged debt —
   * carried through so unmerging the new merge, then unmerging that one
   * too, still recovers every original rather than losing a level of
   * history (see supabase/migrations/0010_debts_unmerge_support.sql). */
  merged_from?: MergedDebtSnapshot[] | null;
}

/** Builds the `merged_from` snapshot stored on a new merged debt row —
 * one entry per row being folded into it, deep enough that "Unmerge" on
 * the Debts page can recreate every original row exactly. Used by both
 * app/(app)/debts.tsx's confirmMerge (the manual multi-select merge) and
 * lib/split-people.ts's createOrMergeDebtsForSplit (the "merge with
 * existing debt" offer at save time). */
export function buildMergedFromSnapshot(sources: MergedDebtSourceRow[]): MergedDebtSnapshot[] {
  return sources.map((s) => ({
    owed_by_name: s.owed_by_name,
    amount: s.amount,
    message: s.message,
    transaction_id: s.transaction_id,
    target_account_id: s.target_account_id,
    merged_from: s.merged_from ?? null,
  }));
}
