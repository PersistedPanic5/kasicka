import { createElement, useRef, useState } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { useLanguage } from '@/lib/language-context';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { NameAutocompleteInput } from '@/components/NameAutocompleteInput';
import { ShareModePicker } from '@/components/ShareModePicker';
import { createGroupDebts, groupProblem, type ShareMode } from '@/lib/debt-groups';
import {
  createOrMergeDebtsForSplit,
  emptySplitPerson,
  splitEvenly,
  splitPeopleSum,
  validSplitPeople,
  type DebtHistory,
  type SplitPerson,
} from '@/lib/split-people';

/**
 * Note, receipt photo and "split part of this with someone" for a bank
 * payment — the same three things the normal Record-expense form has
 * (components/ExpenseEntryForm.tsx), so a payment coming from the bank can
 * be recorded just as fully. Held in the caller's state (one `Extras` per
 * inbox row) and applied right after `bank_post` creates the transaction.
 */
export type Extras = {
  note: string;
  photoPath: string | null;
  photoUrl: string | null;
  splitOn: boolean;
  total: string;
  message: string;
  people: SplitPerson[];
  /** names (trimmed, lower-case) the user chose NOT to fold into an open debt */
  noMerge: string[];
  shareMode: ShareMode;
};

export const emptyExtras = (): Extras => ({
  note: '',
  photoPath: null,
  photoUrl: null,
  splitOn: false,
  total: '',
  message: '',
  people: [emptySplitPerson()],
  noMerge: [],
  shareMode: 'INDIVIDUAL',
});

export const hasExtras = (e?: Extras) => !!e && !!(e.note.trim() || e.photoPath || (e.splitOn && validSplitPeople(e.people).length));

/** Returns an i18n key when the split can't be saved as typed, else null. Check BEFORE bank_post. */
export function splitProblem(e: Extras | undefined, amount: number): string | null {
  if (!e?.splitOn || !validSplitPeople(e.people).length) return null;
  const total = Number(e.total) || 0;
  if (total <= 0) return null;
  if (total > amount) return 'home.splitTooBig';
  if (splitPeopleSum(e.people) > total + 0.01) return 'home.splitOverAllocatedError';
  return groupProblem(e.shareMode, validSplitPeople(e.people));
}

/** After bank_post: attach the photo and create / merge the debts. Never throws. */
export async function applyExtras(p: {
  ownerId: string;
  transactionId: string;
  accountId: string;
  eventId: string | null;
  extras: Extras | undefined;
  history: DebtHistory;
  currencyLabel: string;
}): Promise<{ debts: number; error: string | null }> {
  const e = p.extras;
  if (!e) return { debts: 0, error: null };
  let error: string | null = null;
  if (e.photoPath) {
    const { error: err } = await supabase.from('transactions').update({ receipt_photo_url: e.photoPath }).eq('id', p.transactionId);
    if (err) error = err.message;
  }
  const people = validSplitPeople(e.people);
  const total = Number(e.total) || 0;
  if (e.splitOn && people.length && total > 0 && e.shareMode !== 'INDIVIDUAL') {
    const g = await createGroupDebts({
      ownerId: p.ownerId,
      transactionId: p.transactionId,
      eventId: p.eventId,
      targetAccountId: p.accountId,
      message: e.message.trim() || null,
      mode: e.shareMode as 'ONE_QR' | 'PER_PERSON',
      people,
    });
    return { debts: g.count, error: g.error ?? error };
  }
  if (e.splitOn && people.length && total > 0) {
    const mergeNames = new Set(
      people.map((x) => x.name.trim().toLowerCase()).filter((n) => p.history.outstandingByName.has(n) && !e.noMerge.includes(n)),
    );
    const res = await createOrMergeDebtsForSplit({
      ownerId: p.ownerId,
      transactionId: p.transactionId,
      eventId: p.eventId,
      targetAccountId: p.accountId,
      message: e.message.trim() || null,
      people,
      outstandingByName: p.history.outstandingByName,
      mergeNames,
      currencyLabel: p.currencyLabel,
    });
    if (res.error) error = res.error;
    return { debts: res.links.length, error };
  }
  return { debts: 0, error };
}

type Tokens = ReturnType<typeof useTheme>['tokens'];

export function NoteField({ value, onChange }: { value: Extras; onChange: (e: Extras) => void }) {
  const { tokens } = useTheme();
  const { t } = useLanguage();
  return (
    <TextInput
      value={value.note}
      onChangeText={(note) => onChange({ ...value, note })}
      placeholder={t('bank.notePlaceholder')}
      placeholderTextColor={tokens.textMuted}
      style={[s.input, { borderColor: tokens.border, backgroundColor: tokens.cardAlt, color: tokens.text }]}
    />
  );
}

export function PhotoField({ value, onChange }: { value: Extras; onChange: (e: Extras) => void }) {
  const { tokens } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const ref = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (Platform.OS !== 'web') {
    return <Text style={[s.hint, { color: tokens.textMuted }]}>{t('home.photoWebOnly')}</Text>;
  }

  async function pick(e: { target: { files: FileList | null } }) {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    setError(null);
    setBusy(true);
    const ext = file.name.includes('.') ? file.name.split('.').pop() : 'jpg';
    const path = `${user.id}/${Date.now()}.${ext}`;
    const { error: err } = await supabase.storage.from('receipts').upload(path, file, { contentType: file.type || 'image/jpeg' });
    setBusy(false);
    if (err) return setError(err.message);
    onChange({ ...value, photoPath: path, photoUrl: URL.createObjectURL(file) });
  }

  return (
    <View style={{ gap: 8 }}>
      {value.photoUrl ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Image source={{ uri: value.photoUrl }} style={s.preview} />
          <Pressable onPress={() => onChange({ ...value, photoPath: null, photoUrl: null })} style={s.small}>
            <Text style={{ color: tokens.coral, fontFamily: fontFamily.bold, fontSize: 13 }}>{t('common.delete')}</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          onPress={() => ref.current?.click()}
          disabled={busy}
          style={[s.btn, { borderColor: tokens.border, backgroundColor: tokens.cardAlt, opacity: busy ? 0.6 : 1 }]}
        >
          <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 14 }}>{busy ? t('common.saving') : t('home.addPhoto')}</Text>
        </Pressable>
      )}
      {error && <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 12.5 }}>{error}</Text>}
      {createElement('input', { ref, type: 'file', accept: 'image/*', capture: 'environment', style: { display: 'none' }, onChange: pick })}
    </View>
  );
}

function Tick({ on, label, onPress, tokens }: { on: boolean; label: string; onPress: () => void; tokens: Tokens }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="checkbox" accessibilityState={{ checked: on }} style={s.tickRow}>
      <View style={[s.box, { borderColor: on ? tokens.accent : tokens.border, backgroundColor: on ? tokens.accent : tokens.cardAlt }]}>
        {on && <Text style={{ color: tokens.accentText, fontFamily: fontFamily.extrabold, fontSize: 12, lineHeight: 14 }}>✓</Text>}
      </View>
      <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13, flex: 1 }}>{label}</Text>
    </Pressable>
  );
}

export function SplitFields({
  value,
  onChange,
  amount,
  history,
}: {
  value: Extras;
  onChange: (e: Extras) => void;
  /** the payment's CZK amount — pre-fills the split total */
  amount: number;
  history: DebtHistory;
}) {
  const { tokens } = useTheme();
  const { t } = useLanguage();

  if (!value.splitOn) {
    return (
      <Pressable
        onPress={() => onChange({ ...value, splitOn: true, total: value.total || String(amount) })}
        style={[s.btn, { borderColor: tokens.border, backgroundColor: tokens.cardAlt }]}
      >
        <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 14 }}>{t('home.splitToggleOn')}</Text>
      </Pressable>
    );
  }

  const total = Number(value.total) || 0;
  const sum = splitPeopleSum(value.people);
  const remaining = Math.round((total - sum) * 100) / 100;
  const setPerson = (id: string, field: 'name' | 'amount', v: string) =>
    onChange({ ...value, people: value.people.map((p) => (p.id === id ? { ...p, [field]: v } : p)) });
  const field = [s.input, { borderColor: tokens.border, backgroundColor: tokens.cardAlt, color: tokens.text }];

  return (
    <View style={[s.panel, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
      <TextInput
        value={value.total}
        onChangeText={(total) => onChange({ ...value, total })}
        keyboardType="numeric"
        placeholder={t('home.splitTotalPlaceholder')}
        placeholderTextColor={tokens.textMuted}
        style={field}
      />
      <TextInput
        value={value.message}
        onChangeText={(message) => onChange({ ...value, message })}
        placeholder={t('home.messagePlaceholder')}
        placeholderTextColor={tokens.textMuted}
        style={field}
      />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <Pressable
          onPress={() => onChange({ ...value, people: splitEvenly(total, value.people) })}
          disabled={total <= 0}
          style={[s.small, { backgroundColor: tokens.cardAlt, opacity: total > 0 ? 1 : 0.5 }]}
        >
          <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 13 }}>{t('home.splitEvenlyBtn')}</Text>
        </Pressable>
        <Text style={{ color: remaining === 0 ? tokens.greenFg : remaining < 0 ? tokens.coral : tokens.textMuted, fontFamily: fontFamily.semibold, fontSize: 13 }}>
          {sum} / {total || 0} {t('common.czk')}
          {remaining > 0 ? ` · ${t('home.splitStillMissing')} ${remaining}` : ''}
          {remaining < 0 ? ` · ${t('home.splitOverAllocated')} ${Math.abs(remaining)}` : ''}
        </Text>
      </View>
      {value.people.map((p) => {
        const key = p.name.trim().toLowerCase();
        const open = history.outstandingByName.get(key);
        return (
          <View key={p.id} style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <NameAutocompleteInput
                value={p.name}
                onChangeText={(v) => setPerson(p.id, 'name', v)}
                pastNames={history.pastNames}
                placeholder={t('home.whoOwesPlaceholder')}
                containerStyle={{ flex: 2 }}
                inputStyle={field}
              />
              <TextInput
                value={p.amount}
                onChangeText={(v) => setPerson(p.id, 'amount', v)}
                keyboardType="numeric"
                placeholder={t('home.howMuchPlaceholder')}
                placeholderTextColor={tokens.textMuted}
                style={[...field, { flex: 1 }]}
              />
              {value.people.length > 1 && (
                <Pressable onPress={() => onChange({ ...value, people: value.people.filter((x) => x.id !== p.id) })} hitSlop={8} style={s.x}>
                  <Text style={{ color: tokens.coral, fontFamily: fontFamily.bold, fontSize: 18 }}>×</Text>
                </Pressable>
              )}
            </View>
            {open && value.shareMode === 'INDIVIDUAL' && (
              <Tick
                tokens={tokens}
                on={!value.noMerge.includes(key)}
                label={t('bank.mergeInto').replace('{name}', open.owed_by_name).replace('{amount}', String(open.amount))}
                onPress={() => onChange({ ...value, noMerge: value.noMerge.includes(key) ? value.noMerge.filter((n) => n !== key) : [...value.noMerge, key] })}
              />
            )}
          </View>
        );
      })}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Pressable onPress={() => onChange({ ...value, people: [...value.people, emptySplitPerson()] })} style={[s.small, { backgroundColor: tokens.cardAlt }]}>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 13 }}>{t('home.addPersonBtn')}</Text>
        </Pressable>
        <Pressable onPress={() => onChange({ ...value, splitOn: false })} style={s.small}>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.bold, fontSize: 13 }}>{t('home.splitToggleOff')}</Text>
        </Pressable>
      </View>
      <ShareModePicker value={value.shareMode} onChange={(shareMode) => onChange({ ...value, shareMode })} />
      <Text style={[s.hint, { color: tokens.textMuted }]}>{t('home.splitHint')}</Text>
    </View>
  );
}

/** Everything at once — the desktop row's detail panel. */
export function ExtrasAll({ value, onChange, amount, expense, history }: { value: Extras; onChange: (e: Extras) => void; amount: number; expense: boolean; history: DebtHistory }) {
  return (
    <View style={{ gap: 10 }}>
      <NoteField value={value} onChange={onChange} />
      {expense && <SplitFields value={value} onChange={onChange} amount={amount} history={history} />}
      <PhotoField value={value} onChange={onChange} />
    </View>
  );
}

const s = StyleSheet.create({
  input: { height: 46, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, fontFamily: fontFamily.semibold, fontSize: 14 },
  btn: { alignSelf: 'flex-start', minHeight: 44, borderRadius: 12, borderWidth: 1, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  small: { minHeight: 44, borderRadius: 10, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  x: { width: 36, height: 44, alignItems: 'center', justifyContent: 'center' },
  panel: { borderWidth: 1, borderRadius: 16, padding: 12, gap: 10 },
  hint: { fontFamily: fontFamily.medium, fontSize: 12, lineHeight: 17 },
  preview: { width: 72, height: 72, borderRadius: 12 },
  tickRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 36 },
  box: { width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
});
