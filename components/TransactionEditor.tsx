import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth-context';
import { useLanguage } from '@/lib/language-context';
import {
  createOrMergeDebtsForSplit,
  emptySplitPerson,
  splitEvenly,
  splitPeopleSum,
  useDebtHistory,
  validSplitPeople,
  type OutstandingDebtMatch,
  type SplitPerson,
} from '@/lib/split-people';
import { NameAutocompleteInput } from '@/components/NameAutocompleteInput';
import { categoryColor } from '@/lib/identity';
import { budgetMonthForDate } from '@/lib/budget-month';
import type { DebtStatus, EventRow } from '@/types/database';

export type TransactionRow = {
  id: string;
  transaction_date: string;
  type: string;
  amount: number;
  note: string | null;
  status: string;
  category_id: string | null;
  account_id: string;
  event_id?: string | null;
  receipt_photo_url: string | null;
  categories: { name: string } | null;
};

/** One split person's name matching an existing outstanding debt, offered
 * for merging at Save time — see lib/split-people.ts's createOrMergeDebtsForSplit. */
interface MergeOfferMatch {
  name: string;
  newAmount: number;
  existing: OutstandingDebtMatch;
}

type LinkedDebt = { id: string; owed_by_name: string; amount: number; status: DebtStatus; share_token: string };

/**
 * THE edit menu for a real transaction — opened from Transactions,
 * Overview's category drill-down (both via components/TransactionList.tsx)
 * and the Debts page ("Edit expense"). It carries every option Record
 * Expense has that still makes sense after the fact: amount, date, note,
 * category, event, account, receipt photo (add/replace/remove) and the
 * split-with-people panel, which also lists who the expense is ALREADY
 * split with and whether each part is waiting or settled.
 *
 * Not editable here: the currency an expense was originally entered in
 * (`amount` is always the stored CZK figure; changing currency would mean
 * re-resolving a rate for the date) — ponytail: add when needed.
 *
 * Mounted only while open (callers render it conditionally), so all state
 * simply initialises from the `transaction` prop. The split part saves on
 * its own button, immediately (it creates debts, independent of the main
 * Save), exactly as the old detail modal did.
 */
export function TransactionEditor({
  transaction,
  categories,
  accounts,
  events = [],
  monthStartDay,
  expandSplit = false,
  onClose,
  onChanged,
}: {
  transaction: TransactionRow;
  categories: { id: string; name: string }[];
  accounts: { id: string; name: string }[];
  events?: Pick<EventRow, 'id' | 'name' | 'active'>[];
  /** `profile.month_start_day` — an edited date can move the transaction
   * across a budget-month boundary (lib/budget-month.ts). Defaults to 1. */
  monthStartDay?: number | null;
  expandSplit?: boolean;
  onClose: () => void;
  /** Called after anything changed (main Save, or a split being created)
   * so the caller can reload its list. */
  onChanged: () => void;
}) {
  const { tokens } = useTheme();
  const { t: tr } = useLanguage();
  const { user } = useAuth();
  const tx = transaction;

  const [amount, setAmount] = useState(String(tx.amount));
  const [note, setNote] = useState(tx.note ?? '');
  const [categoryId, setCategoryId] = useState<string | null>(tx.category_id);
  const [date, setDate] = useState(tx.transaction_date);
  const [eventId, setEventId] = useState<string | null>(tx.event_id ?? null);
  const [accountId, setAccountId] = useState(tx.account_id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── receipt photo ─────────────────────────────────────────────────
  const [photoPath, setPhotoPath] = useState<string | null>(tx.receipt_photo_url);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const fileInputRef = useRef<{ click: () => void; value: string } | null>(null);

  useEffect(() => {
    if (!tx.receipt_photo_url) return;
    setPhotoBusy(true);
    supabase.storage
      .from('receipts')
      .createSignedUrl(tx.receipt_photo_url, 600)
      .then(({ data, error: err }) => {
        if (err || !data) setPhotoError(tr('transactions.photoLoadError'));
        else setPhotoUrl(data.signedUrl);
        setPhotoBusy(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.id]);

  async function handlePhotoChange(e: { target: { files: FileList | null } }) {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    setPhotoError(null);
    setPhotoBusy(true);
    const ext = file.name.includes('.') ? file.name.split('.').pop() : 'jpg';
    const path = `${user.id}/${Date.now()}.${ext}`;
    const { error: err } = await supabase.storage.from('receipts').upload(path, file, {
      contentType: file.type || 'image/jpeg',
    });
    if (err) {
      setPhotoError(err.message);
      setPhotoBusy(false);
      return;
    }
    setPhotoPath(path);
    setPhotoUrl(URL.createObjectURL(file));
    setPhotoBusy(false);
  }

  function removePhoto() {
    setPhotoPath(null);
    setPhotoUrl(null);
    setPhotoError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // ── debts already linked to this expense ──────────────────────────
  const [debts, setDebts] = useState<LinkedDebt[]>([]);
  const [debtsLoading, setDebtsLoading] = useState(true);
  async function loadDebts() {
    const { data } = await supabase
      .from('debts')
      .select('id, owed_by_name, amount, status, share_token')
      .eq('transaction_id', tx.id)
      .order('created_at', { ascending: false });
    setDebts((data as LinkedDebt[] | null) ?? []);
    setDebtsLoading(false);
  }
  useEffect(() => {
    loadDebts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.id]);

  function debtStatusLabel(status: DebtStatus) {
    if (status === 'SETTLED') return tr('debts.settled');
    if (status === 'CLAIMED_PAID') return tr('debts.awaitingConfirmation');
    return tr('transactions.splitWaiting');
  }

  // ── split ─────────────────────────────────────────────────────────
  const [splitEnabled, setSplitEnabled] = useState(expandSplit);
  const [splitTotalAmount, setSplitTotalAmount] = useState('');
  const [splitMessage, setSplitMessage] = useState('');
  const [splitPeople, setSplitPeople] = useState<SplitPerson[]>([emptySplitPerson()]);
  const debtHistory = useDebtHistory();
  const [mergeOffer, setMergeOffer] = useState<{ matches: MergeOfferMatch[]; chosen: Set<string> } | null>(null);
  const [splitSaving, setSplitSaving] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);
  const [splitShareLinks, setSplitShareLinks] = useState<{ name: string; link: string }[]>([]);
  const [splitCopiedIdx, setSplitCopiedIdx] = useState<number | null>(null);

  const splitSum = useMemo(() => splitPeopleSum(splitPeople), [splitPeople]);
  const splitTotalNumeric = Number(splitTotalAmount) || 0;
  const splitRemaining = Math.round((splitTotalNumeric - splitSum) * 100) / 100;

  function linkForToken(token: string) {
    if (Platform.OS === 'web' && typeof window !== 'undefined') return `${window.location.origin}/d/${token}`;
    return `/d/${token}`;
  }
  function updateSplitPerson(id: string, field: 'name' | 'amount', value: string) {
    setSplitPeople((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
  }
  function setMergeChoice(key: string, shouldMerge: boolean) {
    setMergeOffer((prev) => {
      if (!prev) return prev;
      const next = new Set(prev.chosen);
      if (shouldMerge) next.add(key);
      else next.delete(key);
      return { ...prev, chosen: next };
    });
  }

  async function saveSplitDebt(offer?: { matches: MergeOfferMatch[]; chosen: Set<string> }) {
    if (!user) return;
    const validPeople = validSplitPeople(splitPeople);
    if (validPeople.length === 0) return setSplitError(tr('debts.nameError'));
    if (splitTotalNumeric <= 0) return setSplitError(tr('debts.amountError'));
    if (splitTotalNumeric > tx.amount) return setSplitError(tr('home.splitTooBig'));
    if (splitSum > splitTotalNumeric + 0.01) return setSplitError(tr('home.splitOverAllocatedError'));

    if (!offer) {
      const matches = validPeople
        .map((p): MergeOfferMatch | null => {
          const existing = debtHistory.outstandingByName.get(p.name.trim().toLowerCase());
          return existing ? { name: p.name, newAmount: p.amount, existing } : null;
        })
        .filter((m): m is MergeOfferMatch => m !== null);
      if (matches.length > 0) {
        setMergeOffer({ matches, chosen: new Set(matches.map((m) => m.name.trim().toLowerCase())) });
        return;
      }
    }

    setSplitSaving(true);
    setSplitError(null);
    const { links, error: err } = await createOrMergeDebtsForSplit({
      ownerId: user.id,
      transactionId: tx.id,
      targetAccountId: accountId,
      message: splitMessage.trim() || null,
      people: validPeople,
      outstandingByName: debtHistory.outstandingByName,
      mergeNames: offer?.chosen ?? new Set(),
      currencyLabel: tr('common.czk'),
    });
    setMergeOffer(null);

    if (links.length > 0) {
      await loadDebts();
      setSplitShareLinks(links.map((l) => ({ name: l.name, link: linkForToken(l.token) })));
      setSplitTotalAmount('');
      setSplitMessage('');
      setSplitPeople([emptySplitPerson()]);
      onChanged();
    }
    if (err) setSplitError(err);
    setSplitSaving(false);
  }

  async function copySplitLink(idx: number) {
    const link = splitShareLinks[idx];
    if (!link) return;
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(link.link);
      setSplitCopiedIdx(idx);
      setTimeout(() => setSplitCopiedIdx(null), 1500);
    }
  }

  // ── main save ─────────────────────────────────────────────────────
  async function save() {
    const numericAmount = Number(amount);
    if (!numericAmount || numericAmount <= 0) return setError(tr('transactions.amountError'));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setError(tr('transactions.dateError'));
    setSaving(true);
    setError(null);
    const { error: err } = await supabase
      .from('transactions')
      .update({
        amount: numericAmount,
        note: note.trim() || null,
        category_id: categoryId,
        transaction_date: date,
        // Keep budget_month in sync so an edited date actually moves the
        // transaction to the right month bucket — see lib/budget-month.ts.
        budget_month: budgetMonthForDate(date, monthStartDay ?? 1),
        event_id: eventId,
        account_id: accountId,
        receipt_photo_url: photoPath,
      })
      .eq('id', tx.id);
    if (err) {
      setError(err.message);
      setSaving(false);
      return;
    }
    onChanged();
    onClose();
  }

  const label = (text: string, first = false) => (
    <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginTop: first ? 0 : 12, marginBottom: 6 }}>
      {text}
    </Text>
  );
  const chip = (key: string, text: string, active: boolean, onPress: () => void, extra?: { dot?: string; dim?: boolean }) => (
    <Pressable
      key={key}
      onPress={onPress}
      style={[styles.chip, { backgroundColor: active ? tokens.accent : tokens.card, opacity: extra?.dim ? 0.6 : 1 }]}
    >
      {!active && extra?.dot && <View style={[styles.categoryDot, { backgroundColor: extra.dot }]} />}
      <Text style={{ color: active ? tokens.accentText : tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>{text}</Text>
    </Pressable>
  );

  return (
    <>
      <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.border }]}>
            <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 16, marginBottom: 14 }}>
              {tr('transactions.editTitle')}
            </Text>

            <ScrollView showsVerticalScrollIndicator={false} style={{ flexShrink: 1 }}>
              {label(tr('transactions.amountLabel'), true)}
              <TextInput
                value={amount}
                onChangeText={setAmount}
                keyboardType="numeric"
                style={[styles.modalInput, { color: tokens.text, borderColor: tokens.border }]}
              />

              {label(tr('transactions.dateLabel'))}
              {Platform.OS === 'web' ? (
                createElement('input', {
                  type: 'date',
                  value: date,
                  onChange: (e: { target: { value: string } }) => setDate(e.target.value),
                  style: {
                    borderWidth: 1,
                    borderColor: tokens.border,
                    borderRadius: 10,
                    paddingLeft: 12,
                    paddingRight: 12,
                    paddingTop: 10,
                    paddingBottom: 10,
                    fontSize: 14,
                    color: tokens.text,
                    background: 'transparent',
                    fontFamily: 'inherit',
                  },
                })
              ) : (
                <TextInput
                  value={date}
                  onChangeText={setDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={tokens.textMuted}
                  style={[styles.modalInput, { color: tokens.text, borderColor: tokens.border }]}
                />
              )}

              {label(tr('transactions.noteLabel'))}
              <TextInput
                value={note}
                onChangeText={setNote}
                placeholder={tr('transactions.noteFieldPlaceholder')}
                placeholderTextColor={tokens.textMuted}
                style={[styles.modalInput, { color: tokens.text, borderColor: tokens.border }]}
              />

              {categories.length > 0 && (
                <>
                  {label(tr('transactions.categoryLabel'))}
                  <View style={styles.chipRow}>
                    {categories.map((cat, i) =>
                      chip(cat.id, cat.name, categoryId === cat.id, () => setCategoryId(cat.id), { dot: categoryColor(i, tokens) })
                    )}
                  </View>
                </>
              )}

              {events.length > 0 && (
                <>
                  {label(tr('more.events'))}
                  <View style={styles.chipRow}>
                    {chip('none', tr('home.eventOff'), eventId === null, () => setEventId(null))}
                    {events.map((ev) => chip(ev.id, ev.name, eventId === ev.id, () => setEventId(ev.id), { dim: !ev.active }))}
                  </View>
                </>
              )}

              {accounts.length > 0 && (
                <>
                  {label(tr('home.accountLabel'))}
                  <View style={styles.chipRow}>
                    {accounts.map((acc) => chip(acc.id, acc.name, accountId === acc.id, () => setAccountId(acc.id)))}
                  </View>
                </>
              )}

              {label(tr('home.receiptPhotoLabel'))}
              {Platform.OS === 'web' ? (
                <>
                  {photoUrl && (
                    <Pressable onPress={() => window.open(photoUrl, '_blank', 'noopener,noreferrer')}>
                      <Image source={{ uri: photoUrl }} style={styles.photo} resizeMode="cover" />
                      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11, marginTop: 5 }}>
                        {tr('transactions.viewFullPhoto')}
                      </Text>
                    </Pressable>
                  )}
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: photoUrl ? 8 : 0 }}>
                    <Pressable
                      onPress={() => fileInputRef.current?.click()}
                      disabled={photoBusy}
                      style={[styles.smallBtn, { backgroundColor: tokens.cardAlt, opacity: photoBusy ? 0.6 : 1 }]}
                    >
                      <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                        {photoBusy ? tr('common.loading') : photoPath ? tr('transactions.replacePhoto') : tr('home.addPhoto')}
                      </Text>
                    </Pressable>
                    {photoPath && (
                      <Pressable onPress={removePhoto} style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}>
                        <Text style={{ color: tokens.coral, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                          {tr('common.delete')}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                  {photoError && (
                    <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 6 }}>{photoError}</Text>
                  )}
                  {createElement('input', {
                    ref: fileInputRef,
                    type: 'file',
                    accept: 'image/*',
                    capture: 'environment',
                    style: { display: 'none' },
                    onChange: handlePhotoChange,
                  })}
                </>
              ) : (
                <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5 }}>{tr('home.photoWebOnly')}</Text>
              )}

              {(debtsLoading || debts.length > 0) && (
                <>
                  {label(tr('transactions.existingDebtsLabel'))}
                  {debtsLoading ? (
                    <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5 }}>{tr('common.loading')}</Text>
                  ) : (
                    debts.map((d) => (
                      <View key={d.id} style={[styles.existingDebtRow, { borderColor: tokens.border }]}>
                        <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13 }}>{d.owed_by_name}</Text>
                        <Text
                          style={{
                            color: d.status === 'SETTLED' ? tokens.greenFg : tokens.amberFg,
                            fontFamily: fontFamily.medium,
                            fontSize: 12.5,
                          }}
                        >
                          {d.amount} {tr('common.czk')} · {debtStatusLabel(d.status)}
                        </Text>
                      </View>
                    ))
                  )}
                </>
              )}

              {tx.type === 'EXPENSE' && (
                <>
                  <Pressable onPress={() => setSplitEnabled((v) => !v)} style={styles.splitToggle}>
                    <Text style={{ color: tokens.accent, fontFamily: fontFamily.semibold, fontSize: 13 }}>
                      {splitEnabled ? tr('home.splitToggleOff') : tr('home.splitToggleOn')}
                    </Text>
                  </Pressable>

                  {splitEnabled && (
                    <View style={[styles.splitPanel, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
                      <TextInput
                        value={splitTotalAmount}
                        onChangeText={setSplitTotalAmount}
                        keyboardType="numeric"
                        placeholder={tr('home.splitTotalPlaceholder')}
                        placeholderTextColor={tokens.textMuted}
                        style={[styles.splitInput, { color: tokens.text, borderColor: tokens.border }]}
                      />
                      <TextInput
                        value={splitMessage}
                        onChangeText={setSplitMessage}
                        placeholder={tr('home.messagePlaceholder')}
                        placeholderTextColor={tokens.textMuted}
                        style={[styles.splitInput, { color: tokens.text, borderColor: tokens.border }]}
                      />

                      <View style={styles.splitEvenlyRow}>
                        <Pressable
                          onPress={() => setSplitPeople((prev) => splitEvenly(splitTotalNumeric, prev))}
                          disabled={splitTotalNumeric <= 0}
                          style={[styles.splitAddPersonBtn, { backgroundColor: tokens.cardAlt, opacity: splitTotalNumeric > 0 ? 1 : 0.5 }]}
                        >
                          <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>{tr('home.splitEvenlyBtn')}</Text>
                        </Pressable>
                        <Text
                          style={{
                            color: splitRemaining === 0 ? tokens.greenFg : splitRemaining < 0 ? tokens.coral : tokens.textMuted,
                            fontFamily: fontFamily.semibold,
                            fontSize: 12.5,
                          }}
                        >
                          {splitSum} / {splitTotalNumeric || 0} {tr('common.czk')}
                          {splitRemaining > 0 ? ` · ${tr('home.splitStillMissing')} ${splitRemaining}` : ''}
                          {splitRemaining < 0 ? ` · ${tr('home.splitOverAllocated')} ${Math.abs(splitRemaining)}` : ''}
                        </Text>
                      </View>

                      {splitPeople.map((p) => (
                        <View key={p.id} style={styles.splitPersonRow}>
                          <NameAutocompleteInput
                            value={p.name}
                            onChangeText={(v) => updateSplitPerson(p.id, 'name', v)}
                            pastNames={debtHistory.pastNames}
                            placeholder={tr('home.whoOwesPlaceholder')}
                            containerStyle={{ flex: 2 }}
                            inputStyle={[styles.splitInput, { color: tokens.text, borderColor: tokens.border }]}
                          />
                          <TextInput
                            value={p.amount}
                            onChangeText={(v) => updateSplitPerson(p.id, 'amount', v)}
                            keyboardType="numeric"
                            placeholder={tr('home.howMuchPlaceholder')}
                            placeholderTextColor={tokens.textMuted}
                            style={[styles.splitInput, { color: tokens.text, borderColor: tokens.border, flex: 1 }]}
                          />
                          {splitPeople.length > 1 && (
                            <Pressable onPress={() => setSplitPeople((prev) => prev.filter((x) => x.id !== p.id))} hitSlop={8}>
                              <Text style={{ color: tokens.coral, fontFamily: fontFamily.bold, fontSize: 16 }}>×</Text>
                            </Pressable>
                          )}
                        </View>
                      ))}
                      <Pressable
                        onPress={() => setSplitPeople((prev) => [...prev, emptySplitPerson()])}
                        style={[styles.splitAddPersonBtn, { backgroundColor: tokens.cardAlt }]}
                      >
                        <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>{tr('home.addPersonBtn')}</Text>
                      </Pressable>

                      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5 }}>{tr('home.splitHint')}</Text>

                      {splitError && (
                        <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 12.5 }}>{splitError}</Text>
                      )}

                      {splitShareLinks.length > 0 && (
                        <View style={[styles.shareBox, { backgroundColor: tokens.greenBg }]}>
                          <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                            {tr('home.shareLinkCreated')}
                          </Text>
                          {splitShareLinks.map((link, idx) => (
                            <View key={link.link} style={{ gap: 4 }}>
                              <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.semibold, fontSize: 12 }}>{link.name}</Text>
                              <Text selectable numberOfLines={1} style={{ color: tokens.greenFg, fontFamily: fontFamily.medium, fontSize: 12 }}>
                                {link.link}
                              </Text>
                              <Pressable onPress={() => copySplitLink(idx)} style={[styles.copyBtn, { backgroundColor: tokens.card }]}>
                                <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12 }}>
                                  {splitCopiedIdx === idx ? tr('common.copied') : tr('common.copyLink')}
                                </Text>
                              </Pressable>
                            </View>
                          ))}
                        </View>
                      )}

                      <Pressable
                        onPress={() => saveSplitDebt()}
                        disabled={splitSaving}
                        style={[styles.splitSaveBtn, { backgroundColor: tokens.accent, opacity: splitSaving ? 0.6 : 1 }]}
                      >
                        <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 14 }}>
                          {splitSaving ? tr('common.saving') : tr('transactions.saveSplit')}
                        </Text>
                      </Pressable>
                    </View>
                  )}
                </>
              )}

              {error && <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 12.5, marginTop: 12 }}>{error}</Text>}
            </ScrollView>

            <View style={styles.modalActions}>
              <Pressable onPress={onClose} style={[styles.modalBtn, { backgroundColor: tokens.card }]}>
                <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>{tr('common.cancel')}</Text>
              </Pressable>
              <Pressable
                onPress={save}
                disabled={saving || photoBusy}
                style={[styles.modalBtn, { backgroundColor: tokens.accent, opacity: saving || photoBusy ? 0.6 : 1 }]}
              >
                <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 14 }}>
                  {saving ? tr('common.saving') : tr('common.save')}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={mergeOffer !== null} transparent animationType="fade" onRequestClose={() => setMergeOffer(null)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.border }]}>
            <ScrollView>
              <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 16, marginBottom: 10 }}>
                {tr('debts.mergeOfferTitle')}
              </Text>
              <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginBottom: 12 }}>
                {tr('debts.mergeOfferIntro')}
              </Text>
              {mergeOffer?.matches.map((m) => {
                const key = m.name.trim().toLowerCase();
                const merging = mergeOffer.chosen.has(key);
                return (
                  <View key={key} style={[styles.mergeOfferRow, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
                    <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 14 }}>{m.name}</Text>
                    <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5 }}>
                      {m.existing.amount} + {m.newAmount} = {m.existing.amount + m.newAmount} {tr('common.czk')}
                    </Text>
                    <View style={styles.mergeChoiceRow}>
                      {[
                        { on: true, text: tr('debts.mergeOfferMerge') },
                        { on: false, text: tr('debts.mergeOfferKeepSeparate') },
                      ].map((opt) => (
                        <Pressable
                          key={String(opt.on)}
                          onPress={() => setMergeChoice(key, opt.on)}
                          style={[styles.mergeChoiceBtn, { backgroundColor: merging === opt.on ? tokens.accent : tokens.cardAlt }]}
                        >
                          <Text
                            style={{
                              color: merging === opt.on ? tokens.accentText : tokens.text,
                              fontFamily: fontFamily.semibold,
                              fontSize: 12.5,
                            }}
                          >
                            {opt.text}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                );
              })}
              <View style={styles.modalActions}>
                <Pressable onPress={() => setMergeOffer(null)} style={[styles.modalBtn, { backgroundColor: tokens.card }]}>
                  <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>{tr('common.cancel')}</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    const offer = mergeOffer;
                    setMergeOffer(null);
                    if (offer) saveSplitDebt(offer);
                  }}
                  disabled={splitSaving}
                  style={[styles.modalBtn, { backgroundColor: tokens.accent, opacity: splitSaving ? 0.6 : 1 }]}
                >
                  <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 14 }}>{tr('debts.mergeOfferContinue')}</Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalCard: { width: '100%', maxWidth: 420, maxHeight: '92%', borderRadius: 18, borderWidth: 1, padding: 20 },
  modalInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  categoryDot: { width: 7, height: 7, borderRadius: 4 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12 },
  smallBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 },
  photo: { width: '100%', height: 180, borderRadius: 12 },
  existingDebtRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1 },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  modalBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  splitToggle: { alignItems: 'center', paddingVertical: 2, marginTop: 18 },
  splitPanel: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 8, marginTop: 8 },
  splitInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  splitPersonRow: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  splitEvenlyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  splitAddPersonBtn: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9 },
  shareBox: { borderRadius: 14, padding: 12, gap: 8 },
  copyBtn: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9 },
  splitSaveBtn: { paddingVertical: 13, borderRadius: 12, alignItems: 'center' },
  mergeOfferRow: { borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 10, gap: 6 },
  mergeChoiceRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  mergeChoiceBtn: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center' },
});
