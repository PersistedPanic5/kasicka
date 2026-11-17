import { supabase } from '@/lib/supabase';
import type { DebtFile } from '@/types/database';

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
