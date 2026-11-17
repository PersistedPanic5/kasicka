import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { useLanguage } from '@/lib/language-context';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { FILE_ACCEPT, insertDebtFiles, openStoredFile, uploadReceipt, type DebtFileRow, type StagedFile } from '@/lib/debt-bill';
import type { DebtOffset } from '@/types/database';

/** Per-person choice when someone already has an open debt (or several are selected). */
export type MergeKind = 'merge' | 'bill' | 'separate';

/** "Attach photo / PDF" — uploads straight to the receipts bucket, hands back what was uploaded. Web only (like every receipt upload here). */
export function AttachButton({ onFiles, label }: { onFiles: (f: StagedFile[]) => void | Promise<void>; label?: string }) {
  const { tokens } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const ref = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (Platform.OS !== 'web') return null;

  async function pick(e: { target: { files: FileList | null; value: string } }) {
    const list = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!list.length || !user) return;
    setError(null);
    setBusy(true);
    try {
      const done: StagedFile[] = [];
      for (const f of list) done.push(await uploadReceipt(user.id, f));
      await onFiles(done);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  return (
    <View style={{ alignSelf: 'flex-start', gap: 4 }}>
      <Pressable
        onPress={() => ref.current?.click()}
        disabled={busy}
        style={[s.small, { backgroundColor: tokens.cardAlt, opacity: busy ? 0.6 : 1 }]}
      >
        <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 13 }}>
          {busy ? t('bill.attaching') : label ?? t('bill.attachFile')}
        </Text>
      </Pressable>
      {error && <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 12 }}>{error}</Text>}
      {createElement('input', { ref, type: 'file', accept: FILE_ACCEPT, multiple: true, style: { display: 'none' }, onChange: pick })}
    </View>
  );
}

/** Small list of attached files with an open / remove action each. */
export function FileChips({ files, onRemove }: { files: { name: string; path?: string }[]; onRemove?: (i: number) => void }) {
  const { tokens } = useTheme();
  const { t } = useLanguage();
  if (!files.length) return null;
  return (
    <View style={{ gap: 6 }}>
      {files.map((f, i) => (
        <View key={`${f.path ?? f.name}-${i}`} style={[s.chip, { backgroundColor: tokens.cardAlt, borderColor: tokens.border }]}>
          <Text numberOfLines={1} style={{ flex: 1, color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
            {f.name}
          </Text>
          {f.path && (
            <Pressable onPress={() => openStoredFile(f.path!)} hitSlop={6}>
              <Text style={{ color: tokens.accent, fontFamily: fontFamily.bold, fontSize: 12.5 }}>{t('bill.openFile')}</Text>
            </Pressable>
          )}
          {onRemove && (
            <Pressable onPress={() => onRemove(i)} hitSlop={6}>
              <Text style={{ color: tokens.coral, fontFamily: fontFamily.bold, fontSize: 12.5 }}>{t('bill.remove')}</Text>
            </Pressable>
          )}
        </View>
      ))}
    </View>
  );
}

/** The big optional "details of the split" window (+ staged files when `files` is given). */
export function DetailsFields({
  details,
  onDetails,
  files,
  onFiles,
}: {
  details: string;
  onDetails: (v: string) => void;
  files?: StagedFile[];
  onFiles?: (f: StagedFile[]) => void;
}) {
  const { tokens } = useTheme();
  const { t } = useLanguage();
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12 }}>{t('bill.detailsLabel')}</Text>
      <TextInput
        value={details}
        onChangeText={onDetails}
        multiline
        placeholder={t('bill.detailsPlaceholder')}
        placeholderTextColor={tokens.textMuted}
        style={[s.area, { borderColor: tokens.border, backgroundColor: tokens.cardAlt, color: tokens.text }]}
      />
      {files && onFiles && (
        <>
          <FileChips files={files} onRemove={(i) => onFiles(files.filter((_, j) => j !== i))} />
          <AttachButton onFiles={(f) => onFiles([...files, ...f])} />
        </>
      )}
    </View>
  );
}

/** Merge / bill with details / keep separate. */
export function MergeChoice({ value, onChange, compact, noSeparate }: { value: MergeKind; onChange: (k: MergeKind) => void; compact?: boolean; noSeparate?: boolean }) {
  const { tokens } = useTheme();
  const { t } = useLanguage();
  const all: { k: MergeKind; label: string; hint: string }[] = [
    { k: 'merge', label: t('bill.choiceMerge'), hint: t('bill.choiceMergeHint') },
    { k: 'bill', label: t('bill.choiceBill'), hint: t('bill.choiceBillHint') },
    { k: 'separate', label: t('bill.choiceSeparate'), hint: t('bill.choiceSeparateHint') },
  ];
  const opts = all.filter((o) => !(noSeparate && o.k === 'separate'));
  return (
    <View style={{ gap: 6 }}>
      {opts.map((o) => {
        const on = value === o.k;
        return (
          <Pressable
            key={o.k}
            onPress={() => onChange(o.k)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            style={[s.opt, { borderColor: on ? tokens.accent : tokens.border, backgroundColor: on ? tokens.cardAlt : 'transparent' }]}
          >
            <View style={[s.radio, { borderColor: on ? tokens.accent : tokens.border }]}>
              {on && <View style={[s.dot, { backgroundColor: tokens.accent }]} />}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 13 }}>{o.label}</Text>
              {!compact && <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginTop: 1 }}>{o.hint}</Text>}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Reciprocated expenses + attachments of an EXISTING debt (Debts page → Edit).
 * Everything here saves immediately; `onChanged` refreshes the list because
 * adding an offset changes the debt's payable amount (migration 0020 trigger).
 */
export function DebtExtrasEditor({
  debtId,
  transactionId,
  hideReceipt,
  onChanged,
}: {
  debtId: string;
  transactionId: string | null;
  hideReceipt: boolean;
  onChanged: () => void;
}) {
  const { tokens } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const [offsets, setOffsets] = useState<DebtOffset[]>([]);
  const [files, setFiles] = useState<DebtFileRow[]>([]);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [offsetFiles, setOffsetFiles] = useState<StagedFile[]>([]);
  const [hide, setHide] = useState(hideReceipt);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [o, f] = await Promise.all([
      supabase.from('debt_offsets').select('*').eq('debt_id', debtId).order('created_at'),
      supabase.from('debt_files').select('id, path, name, mime, offset_id').eq('debt_id', debtId).order('created_at'),
    ]);
    setOffsets((o.data ?? []) as DebtOffset[]);
    setFiles((f.data ?? []) as DebtFileRow[]);
  }, [debtId]);

  useEffect(() => {
    load();
  }, [load]);

  const fail = (m: string) => setError(/cancel the whole debt/i.test(m) ? t('bill.offsetTooBig') : m);

  async function addOffset() {
    const n = Number(amount.replace(',', '.'));
    if (!user || !n || n <= 0) return;
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase
      .from('debt_offsets')
      .insert({ owner_id: user.id, debt_id: debtId, amount: n, note: note.trim() || null })
      .select('id')
      .single();
    if (err || !data) {
      setBusy(false);
      return fail(err?.message ?? '');
    }
    await insertDebtFiles(user.id, debtId, offsetFiles, data.id);
    setAmount('');
    setNote('');
    setOffsetFiles([]);
    await load();
    setBusy(false);
    onChanged();
  }

  async function removeOffset(id: string) {
    setError(null);
    const { error: err } = await supabase.from('debt_offsets').delete().eq('id', id);
    if (err) return fail(err.message);
    await load();
    onChanged();
  }

  async function removeFile(id: string) {
    await supabase.from('debt_files').delete().eq('id', id);
    load();
  }

  async function toggleHide() {
    const next = !hide;
    setHide(next);
    await supabase.from('debts').update({ hide_receipt: next }).eq('id', debtId);
  }

  const field = [s.input, { borderColor: tokens.border, backgroundColor: tokens.cardAlt, color: tokens.text }];
  const debtFiles = files.filter((f) => !f.offset_id);

  return (
    <View style={{ gap: 10 }}>
      <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 14, marginTop: 6 }}>{t('bill.offsetsTitle')}</Text>
      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12 }}>{t('bill.offsetsHint')}</Text>
      {offsets.map((o) => (
        <View key={o.id} style={{ gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={{ flex: 1, color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13 }}>
              − {o.amount} {t('common.czk')}
              {o.note ? ` · ${o.note}` : ''}
            </Text>
            <Pressable onPress={() => removeOffset(o.id)} hitSlop={8}>
              <Text style={{ color: tokens.coral, fontFamily: fontFamily.bold, fontSize: 12.5 }}>{t('common.delete')}</Text>
            </Pressable>
          </View>
          <FileChips files={files.filter((f) => f.offset_id === o.id)} />
        </View>
      ))}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput
          value={amount}
          onChangeText={setAmount}
          keyboardType="numeric"
          placeholder={t('bill.offsetAmount')}
          placeholderTextColor={tokens.textMuted}
          style={[...field, { flex: 1 }]}
        />
        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder={t('bill.offsetNote')}
          placeholderTextColor={tokens.textMuted}
          style={[...field, { flex: 2 }]}
        />
      </View>
      <FileChips files={offsetFiles} onRemove={(i) => setOffsetFiles(offsetFiles.filter((_, j) => j !== i))} />
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <AttachButton onFiles={(f) => setOffsetFiles([...offsetFiles, ...f])} />
        <Pressable
          onPress={addOffset}
          disabled={busy || !Number(amount.replace(',', '.'))}
          style={[s.small, { backgroundColor: tokens.accent, opacity: busy || !Number(amount.replace(',', '.')) ? 0.5 : 1 }]}
        >
          <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 13 }}>{t('bill.offsetAdd')}</Text>
        </Pressable>
      </View>
      {error && <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 12.5 }}>{error}</Text>}

      <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 14, marginTop: 10 }}>{t('bill.filesTitle')}</Text>
      <FileChips
        files={debtFiles}
        onRemove={(i) => removeFile(debtFiles[i].id)}
      />
      <AttachButton
        onFiles={async (f) => {
          if (user) await insertDebtFiles(user.id, debtId, f);
          load();
        }}
      />
      {transactionId && (
        <Pressable onPress={toggleHide} accessibilityRole="checkbox" accessibilityState={{ checked: hide }} style={s.tickRow}>
          <View style={[s.box, { borderColor: hide ? tokens.accent : tokens.border, backgroundColor: hide ? tokens.accent : tokens.cardAlt }]}>
            {hide && <Text style={{ color: tokens.accentText, fontFamily: fontFamily.extrabold, fontSize: 12, lineHeight: 14 }}>✓</Text>}
          </View>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13, flex: 1 }}>{t('bill.hideReceipt')}</Text>
        </Pressable>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  input: { height: 44, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, fontFamily: fontFamily.semibold, fontSize: 14 },
  area: { minHeight: 120, borderRadius: 12, borderWidth: 1, padding: 12, fontFamily: fontFamily.medium, fontSize: 14, textAlignVertical: 'top' },
  small: { minHeight: 44, borderRadius: 10, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, minHeight: 38 },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1.5, borderRadius: 12, padding: 10 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  tickRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 36, marginTop: 6 },
  box: { width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
});
