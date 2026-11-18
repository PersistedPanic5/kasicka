import { supabase } from '@/lib/supabase';
import type { Debt, DebtFile } from '@/types/database';

/** Receipts / attachments: photos and PDFs. */
export const FILE_ACCEPT = 'image/*,application/pdf';

/** An uploaded file waiting to be attached to a debt that does not exist yet. */
export type StagedFile = { path: string; name: string; mime: string | null };

export const isPdf = (s?: string | null) => !!s && /\.pdf$|application\/pdf/i.test(s);

/** Uploads to the private `receipts` bucket (first folder = user id, as the storage policy requires). */
export async function uploadReceipt(userId: string, file: File): Promise<StagedFile> {
  const ext = file.name.includes('.') ? file.name.split('.').pop() : isPdf(file.type) ? 'pdf' : 'jpg';
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const { error } = await supabase.storage.from('receipts').upload(path, file, {
    contentType: file.type || (ext === 'pdf' ? 'application/pdf' : 'image/jpeg'),
  });
  if (error) throw new Error(error.message);
  return { path, name: file.name || `receipt.${ext}`, mime: file.type || null };
}

export async function insertDebtFiles(userId: string, debtId: string, files: StagedFile[], offsetId: string | null = null) {
  if (files.length === 0) return;
  await supabase.from('debt_files').insert(
    files.map((f) => ({ owner_id: userId, debt_id: debtId, offset_id: offsetId, path: f.path, name: f.name, mime: f.mime }))
  );
}

/** Owner-side viewing: signed URL for one stored path, opened in a new tab (opened synchronously to dodge popup blockers). */
export async function openStoredFile(path: string) {
  const w = typeof window !== 'undefined' ? window.open('', '_blank') : null;
  const { data } = await supabase.storage.from('receipts').createSignedUrl(path, 300);
  if (data?.signedUrl) {
    if (w) w.location.href = data.signedUrl;
    else if (typeof window !== 'undefined') window.location.href = data.signedUrl;
  } else w?.close();
}

export type DebtFileRow = Pick<DebtFile, 'id' | 'path' | 'name' | 'mime' | 'offset_id'>;

/** Columns the edit dialog needs from `debts`. */
export const DEBT_EDIT_COLUMNS =
  'id, owed_by_name, amount, base_amount, status, share_token, transaction_id, message, details, breakdown, hide_receipt, group_id';

export type EditableDebt = Pick<
  Debt,
  | 'id' | 'owed_by_name' | 'amount' | 'base_amount' | 'status' | 'share_token' | 'transaction_id'
  | 'message' | 'details' | 'breakdown' | 'hide_receipt' | 'group_id'
>;

/** Unpaid = still editable. Paid (SETTLED) is frozen: the budget credit has already been booked. */
export const isUnpaid = (status: string) => status === 'OUTSTANDING' || status === 'CLAIMED_PAID';

/**
 * The columns to write when the owner types a new ORIGINAL (gross) amount.
 * With reciprocated expenses the payable amount stays "original minus those"; null = would be <= 0.
 */
export function amountPatch(d: { amount: number; base_amount: number | null }, gross: number) {
  const off = d.base_amount != null ? Number(d.base_amount) - Number(d.amount) : 0;
  const net = Math.round((gross - off) * 100) / 100;
  if (!(gross > 0) || net <= 0) return null;
  return d.base_amount != null ? { base_amount: gross, amount: net } : { amount: gross };
}

export type BillLine = { title: string; base: number | null; amount: number; offsets: { amount: number; note: string | null }[] };
export type BillBreakdown = { lines: BillLine[]; offsets: { amount: number; note: string | null }[]; total: number; base: number | null };

/** For the Debts list: what each bill is made of, step by step (short name, reciprocated expenses, total). */
export async function loadBillBreakdowns(
  bills: { id: string; share_token: string; amount: number; base_amount: number | null }[]
): Promise<Map<string, BillBreakdown>> {
  const out = new Map<string, BillBreakdown>();
  if (bills.length === 0) return out;
  const { data: kids } = await supabase
    .from('debts')
    .select('id, merged_into_token, message, owed_by_name, amount, base_amount, transaction_id, created_at')
    .in('merged_into_token', bills.map((b) => b.share_token))
    .eq('status', 'MERGED')
    .order('created_at');
  const children = kids ?? [];
  const ids = [...children.map((c) => c.id), ...bills.map((b) => b.id)];
  const txIds = [...new Set(children.map((c) => c.transaction_id).filter((x): x is string => !!x))];
  const [{ data: offs }, { data: txs }] = await Promise.all([
    supabase.from('debt_offsets').select('debt_id, amount, note').in('debt_id', ids).order('created_at'),
    txIds.length ? supabase.from('transactions').select('id, note').in('id', txIds) : Promise.resolve({ data: [] as { id: string; note: string | null }[] }),
  ]);
  const noteOf = new Map((txs ?? []).map((x) => [x.id, x.note]));
  const offsOf = (id: string) => (offs ?? []).filter((o) => o.debt_id === id).map((o) => ({ amount: Number(o.amount), note: o.note }));
  for (const b of bills) {
    out.set(b.id, {
      lines: children
        .filter((c) => c.merged_into_token === b.share_token)
        .map((c) => ({
          title: c.message || (c.transaction_id ? noteOf.get(c.transaction_id) : null) || c.owed_by_name,
          base: c.base_amount == null ? null : Number(c.base_amount),
          amount: Number(c.amount),
          offsets: offsOf(c.id),
        })),
      offsets: offsOf(b.id),
      total: Number(b.amount),
      base: b.base_amount == null ? null : Number(b.base_amount),
    });
  }
  return out;
}
