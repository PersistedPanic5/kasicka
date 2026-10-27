import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase';

/**
 * One bill, one link for the whole group (supabase/migrations/0019_group_bills.sql).
 *   INDIVIDUAL  today's behaviour: a separate link per person.
 *   ONE_QR      even split: one link + one QR; each person taps their name.
 *   PER_PERSON  any amounts: one link, pick your name, get your own QR.
 * Every person is still an ordinary `debts` row, tied together by group_id.
 */
export type ShareMode = 'INDIVIDUAL' | 'ONE_QR' | 'PER_PERSON';

/** ONE_QR charges everybody the same; amounts that differ by a few cents
 * (100 / 3 → 33.34, 33.33, 33.33) are fine, the highest one is used for all. */
const EVEN_TOLERANCE = 0.05;

/** i18n key when the chosen mode can't be saved with these people, else null. */
export function groupProblem(mode: ShareMode, people: { name: string; amount: number }[]): string | null {
  if (mode === 'INDIVIDUAL') return null;
  if (people.length < 2) return 'home.groupNeedsTwo';
  if (mode === 'ONE_QR') {
    const amounts = people.map((p) => p.amount);
    if (Math.max(...amounts) - Math.min(...amounts) > EVEN_TOLERANCE) return 'home.groupNotEven';
  }
  return null;
}

export function groupLink(token: string): string {
  const origin = Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.origin : 'https://kasicka.eu';
  return `${origin}/g/${token}`;
}

/** Creates the group and one debt per person. Returns the group's share token
 * (null if nothing could be created) and, as for ordinary splits, an error text
 * when something went wrong. */
export async function createGroupDebts(p: {
  ownerId: string;
  transactionId: string | null;
  eventId?: string | null;
  targetAccountId: string;
  message: string | null;
  mode: Exclude<ShareMode, 'INDIVIDUAL'>;
  people: { name: string; amount: number }[];
}): Promise<{ groupToken: string | null; count: number; error: string | null }> {
  const perPerson = Math.max(...p.people.map((x) => x.amount));
  const { data: group, error } = await supabase
    .from('debt_groups')
    .insert({
      owner_id: p.ownerId,
      target_account_id: p.targetAccountId,
      mode: p.mode,
      message: p.message,
      per_person: p.mode === 'ONE_QR' ? perPerson : null,
    })
    .select('id, share_token')
    .single();
  if (error || !group) return { groupToken: null, count: 0, error: error?.message ?? 'group' };

  const { data: debts, error: debtErr } = await supabase
    .from('debts')
    .insert(
      p.people.map((x) => ({
        owner_id: p.ownerId,
        transaction_id: p.transactionId,
        event_id: p.eventId ?? null,
        owed_by_name: x.name,
        amount: p.mode === 'ONE_QR' ? perPerson : x.amount,
        target_account_id: p.targetAccountId,
        message: p.message,
        group_id: group.id,
      }))
    )
    .select('id');
  if (debtErr) {
    await supabase.from('debt_groups').delete().eq('id', group.id); // nothing half-made
    return { groupToken: null, count: 0, error: debtErr.message };
  }
  return { groupToken: group.share_token, count: debts?.length ?? 0, error: null };
}
