import { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
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
import type { DebtStatus } from '@/types/database';

/** One split person's name matching an existing outstanding debt, offered
 * for merging at Save time — see the mergeOffer state below and
 * lib/split-people.ts's createOrMergeDebtsForSplit. */
interface MergeOfferMatch {
  name: string;
  newAmount: number;
  existing: OutstandingDebtMatch;
}

export type TransactionRow = {
  id: string;
  transaction_date: string;
  type: string;
  amount: number;
  note: string | null;
  status: string;
  category_id: string | null;
  account_id: string;
  receipt_photo_url: string | null;
  categories: { name: string } | null;
};

type DetailDebtRow = {
  id: string;
  owed_by_name: string;
  amount: number;
  status: DebtStatus;
  share_token: string;
};

/** The name a row displays when it has no note of its own — its category,
 * or a label for transaction types that never carry one (reserve
 * transfers, debt settlements, ...). Exported so the caller's own
 * search/filter logic (app/(app)/transactions.tsx) matches against
 * exactly the same text this list actually renders. */
export function categoryOrTypeLabel(row: Pick<TransactionRow, 'type' | 'categories'>, tr: (key: string) => string): string {
  const typeLabel: Record<string, string> = {
    EXPENSE: tr('transactions.typeExpense'),
    INCOME: tr('transactions.typeIncome'),
    RESERVE_TRANSFER: tr('transactions.typeReserveTransfer'),
    PAYMENT_FROM_RESERVE: tr('transactions.typeReservePayment'),
    DEBT_SETTLEMENT_CREDIT: tr('transactions.typeDebtSettled'),
  };
  return row.categories?.name ?? typeLabel[row.type] ?? row.type;
}

/** Small stroke-based icon badges shown inline in a row's subtitle — matches
 * the stroke/viewBox conventions already used for the hamburger and
 * quick-entry icons in app/(app)/_layout.tsx. */
function PhotoIcon({ size = 12, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M4 8h3l2-2h6l2 2h3v11H4z" />
      <Circle cx="12" cy="13.2" r="3" />
    </Svg>
  );
}
function PeopleIcon({ size = 12, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
      <Circle cx="9" cy="7" r="4" />
      <Path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <Path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Svg>
  );
}

/**
 * The real-transaction list — row rendering plus edit/delete/split, shared
 * between app/(app)/transactions.tsx (the full list, with search/type/
 * category filters and an optional bulk-select mode) and the Overview
 * per-category drill-down (Pavel: "every category clickable... it might
 * really be basically the same list as is in transactions" — this
 * component IS that shared list, so both places show one identical,
 * compact design instead of two copies drifting apart).
 *
 * The caller owns loading/filtering the `transactions` array itself (month
 * switcher, search box, category chips, whatever) and just hands the
 * already-filtered rows in; this component owns everything about
 * presenting and mutating them — the compact card, the edit modal, the
 * detail modal (photo/existing-debts/split panel), the merge-offer modal,
 * and (opt-in via `selectable`) the bulk-select top bar + delete bar.
 * `onChanged` is called after any edit/delete so the caller reloads its
 * own `transactions` list; a split doesn't change the transaction itself
 * (it links a new debt to the same row), so that's tracked purely locally.
 */
export function TransactionList({
  transactions,
  categories,
  loading = false,
  emptyMessage,
  selectable = false,
  onChanged,
}: {
  transactions: TransactionRow[];
  categories: { id: string; name: string }[];
  loading?: boolean;
  emptyMessage: string;
  selectable?: boolean;
  onChanged: () => void;
}) {
  const { tokens } = useTheme();
  // Aliased to `tr` — `t` below is the loop variable for each transaction.
  const { t: tr } = useLanguage();
  const { user } = useAuth();

  const [debtLinkedIds, setDebtLinkedIds] = useState<Set<string>>(new Set());
  const idsKey = useMemo(() => transactions.map((row) => row.id).join(','), [transactions]);
  useEffect(() => {
    let cancelled = false;
    if (transactions.length === 0) {
      setDebtLinkedIds(new Set());
      return;
    }
    supabase
      .from('debts')
      .select('transaction_id')
      .in('transaction_id', transactions.map((row) => row.id))
      .then(({ data }) => {
        if (!cancelled) setDebtLinkedIds(new Set((data ?? []).map((d) => d.transaction_id)));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const [editing, setEditing] = useState<TransactionRow | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editNote, setEditNote] = useState('');
  const [editCategoryId, setEditCategoryId] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [detail, setDetail] = useState<TransactionRow | null>(null);
  const [detailPhotoUrl, setDetailPhotoUrl] = useState<string | null>(null);
  const [detailPhotoLoading, setDetailPhotoLoading] = useState(false);
  const [detailPhotoError, setDetailPhotoError] = useState<string | null>(null);
  const [detailDebts, setDetailDebts] = useState<DetailDebtRow[]>([]);
  const [detailDebtsLoading, setDetailDebtsLoading] = useState(false);

  const [splitEnabled, setSplitEnabled] = useState(false);
  const [splitTotalAmount, setSplitTotalAmount] = useState('');
  const [splitMessage, setSplitMessage] = useState('');
  const [splitPeople, setSplitPeople] = useState<SplitPerson[]>([emptySplitPerson()]);
  const debtHistory = useDebtHistory();
  const [mergeOffer, setMergeOffer] = useState<{ matches: MergeOfferMatch[]; chosen: Set<string> } | null>(null);
  const [splitSaving, setSplitSaving] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);
  const [splitShareLinks, setSplitShareLinks] = useState<{ name: string; link: string }[]>([]);
  const [splitCopiedIdx, setSplitCopiedIdx] = useState<number | null>(null);

  const isCredit = (type: string) => type === 'INCOME' || type === 'DEBT_SETTLEMENT_CREDIT';

  function toggleSelectMode() {
    setSelectMode((v) => !v);
    setSelectedIds(new Set());
    setBulkConfirm(false);
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setBulkConfirm(false);
  }

  async function handleBulkDelete() {
    if (!bulkConfirm) {
      setBulkConfirm(true);
      setTimeout(() => setBulkConfirm(false), 3000);
      return;
    }
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    await supabase.from('transactions').update({ status: 'VOID' }).in('id', Array.from(selectedIds));
    setBulkBusy(false);
    setBulkConfirm(false);
    setSelectMode(false);
    setSelectedIds(new Set());
    onChanged();
  }

  async function handleDeleteOne(id: string) {
    if (pendingDeleteId !== id) {
      setPendingDeleteId(id);
      setTimeout(() => setPendingDeleteId((cur) => (cur === id ? null : cur)), 3000);
      return;
    }
    setPendingDeleteId(null);
    await supabase.from('transactions').update({ status: 'VOID' }).eq('id', id);
    onChanged();
  }

  function openEdit(t: TransactionRow) {
    setEditing(t);
    setEditAmount(String(t.amount));
    setEditNote(t.note ?? '');
    setEditCategoryId(t.category_id);
    setEditError(null);
  }

  function closeEdit() {
    setEditing(null);
    setEditSaving(false);
    setEditError(null);
  }

  async function saveEdit() {
    if (!editing) return;
    const numericAmount = Number(editAmount);
    if (!numericAmount || numericAmount <= 0) {
      setEditError(tr('transactions.amountError'));
      return;
    }
    setEditSaving(true);
    setEditError(null);
    const { error } = await supabase
      .from('transactions')
      .update({
        amount: numericAmount,
        note: editNote.trim() || null,
        category_id: editCategoryId,
      })
      .eq('id', editing.id);

    if (error) {
      setEditError(error.message);
      setEditSaving(false);
      return;
    }
    closeEdit();
    onChanged();
  }

  function linkForToken(token: string) {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      return `${window.location.origin}/d/${token}`;
    }
    return `/d/${token}`;
  }

  function openDetail(t: TransactionRow, opts?: { expandSplit?: boolean }) {
    setDetail(t);
    setSplitEnabled(Boolean(opts?.expandSplit));
    setSplitTotalAmount('');
    setSplitMessage('');
    setSplitPeople([emptySplitPerson()]);
    setSplitError(null);
    setSplitShareLinks([]);
    setSplitCopiedIdx(null);
    setSplitSaving(false);
    setMergeOffer(null);

    setDetailPhotoUrl(null);
    setDetailPhotoError(null);
    if (t.receipt_photo_url) {
      setDetailPhotoLoading(true);
      supabase.storage
        .from('receipts')
        .createSignedUrl(t.receipt_photo_url, 600)
        .then(({ data, error }) => {
          if (error || !data) setDetailPhotoError(tr('transactions.photoLoadError'));
          else setDetailPhotoUrl(data.signedUrl);
          setDetailPhotoLoading(false);
        });
    }

    setDetailDebts([]);
    setDetailDebtsLoading(true);
    supabase
      .from('debts')
      .select('id, owed_by_name, amount, status, share_token')
      .eq('transaction_id', t.id)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setDetailDebts(data ?? []);
        setDetailDebtsLoading(false);
      });
  }

  function closeDetail() {
    setDetail(null);
  }

  // ── Split-people helpers (shared math with components/ExpenseEntryForm.tsx
  // via lib/split-people.ts) ───────────────────────────────────────────
  const splitSum = useMemo(() => splitPeopleSum(splitPeople), [splitPeople]);
  const splitTotalNumeric = Number(splitTotalAmount) || 0;
  const splitRemaining = Math.round((splitTotalNumeric - splitSum) * 100) / 100;

  function addSplitPerson() {
    setSplitPeople((prev) => [...prev, emptySplitPerson()]);
  }
  function removeSplitPerson(id: string) {
    setSplitPeople((prev) => (prev.length <= 1 ? prev : prev.filter((p) => p.id !== id)));
  }
  function updateSplitPerson(id: string, field: 'name' | 'amount', value: string) {
    setSplitPeople((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
  }
  function handleSplitEvenly() {
    setSplitPeople((prev) => splitEvenly(splitTotalNumeric, prev));
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
    if (!detail || !user) return;
    const validPeople = validSplitPeople(splitPeople);
    if (validPeople.length === 0) {
      setSplitError(tr('debts.nameError'));
      return;
    }
    if (splitTotalNumeric <= 0) {
      setSplitError(tr('debts.amountError'));
      return;
    }
    if (splitTotalNumeric > detail.amount) {
      setSplitError(tr('home.splitTooBig'));
      return;
    }
    if (splitSum > splitTotalNumeric + 0.01) {
      setSplitError(tr('home.splitOverAllocatedError'));
      return;
    }

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
    const { links, error } = await createOrMergeDebtsForSplit({
      ownerId: user.id,
      transactionId: detail.id,
      targetAccountId: detail.account_id,
      message: splitMessage.trim() || null,
      people: validPeople,
      outstandingByName: debtHistory.outstandingByName,
      mergeNames: offer?.chosen ?? new Set(),
      currencyLabel: tr('common.czk'),
    });
    setMergeOffer(null);

    if (links.length > 0) {
      const { data: freshDebts } = await supabase
        .from('debts')
        .select('id, owed_by_name, amount, status, share_token')
        .eq('transaction_id', detail.id)
        .order('created_at', { ascending: false });
      setDetailDebts(freshDebts ?? []);
      setDebtLinkedIds((prev) => new Set(prev).add(detail.id));
      setSplitShareLinks(links.map((l) => ({ name: l.name, link: linkForToken(l.token) })));
      setSplitTotalAmount('');
      setSplitMessage('');
      setSplitPeople([emptySplitPerson()]);
    }
    if (error) setSplitError(error);
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

  function openPhotoFullSize() {
    if (detailPhotoUrl && Platform.OS === 'web' && typeof window !== 'undefined') {
      window.open(detailPhotoUrl, '_blank', 'noopener,noreferrer');
    }
  }

  function debtStatusLabel(status: DebtStatus) {
    if (status === 'SETTLED') return tr('debts.settled');
    if (status === 'CLAIMED_PAID') return tr('debts.awaitingConfirmation');
    return tr('debts.outstanding');
  }

  return (
    <View>
      {selectable && (
        <View style={styles.topBar}>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5 }}>
            {selectMode && selectedIds.size > 0 ? `${selectedIds.size} ${tr('transactions.selected')}` : ' '}
          </Text>
          <Pressable onPress={toggleSelectMode}>
            <Text style={{ color: tokens.accent, fontFamily: fontFamily.semibold, fontSize: 13 }}>
              {selectMode ? tr('common.cancel') : tr('common.select')}
            </Text>
          </Pressable>
        </View>
      )}

      {loading && <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium }}>{tr('common.loading')}</Text>}
      {!loading && transactions.length === 0 && (
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 14 }}>{emptyMessage}</Text>
      )}

      {transactions.map((t) => {
        const categoryName = categoryOrTypeLabel(t, tr);
        const primaryName = t.note?.trim() || categoryName;
        const showCategoryAsSubtitle = Boolean(t.note?.trim()) && categoryName !== primaryName;
        const selected = selectedIds.has(t.id);
        const isExpense = t.type === 'EXPENSE';
        const hasPhoto = Boolean(t.receipt_photo_url);
        const hasDebt = debtLinkedIds.has(t.id);
        return (
          <Pressable
            key={t.id}
            onPress={() => (selectMode ? toggleSelected(t.id) : openDetail(t))}
            style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.border }]}
          >
            <View style={styles.row1}>
              {selectMode && (
                <View
                  style={[
                    styles.checkbox,
                    {
                      borderColor: selected ? tokens.accent : tokens.border,
                      backgroundColor: selected ? tokens.accent : 'transparent',
                    },
                  ]}
                >
                  {selected && <Text style={{ color: tokens.accentText, fontSize: 11, fontFamily: fontFamily.bold }}>✓</Text>}
                </View>
              )}
              <Text numberOfLines={1} style={{ flex: 1, color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13.5 }}>
                {primaryName}
              </Text>
              <Text
                style={{
                  color: isCredit(t.type) ? tokens.greenFg : tokens.text,
                  fontFamily: fontFamily.bold,
                  fontSize: 14,
                  fontVariant: ['tabular-nums'],
                }}
              >
                {isCredit(t.type) ? '+' : '−'}
                {t.amount} CZK
              </Text>
            </View>

            <View style={styles.row2}>
              <View style={styles.subtitleRow}>
                <Text numberOfLines={1} style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5 }}>
                  {t.transaction_date}
                  {showCategoryAsSubtitle ? ` · ${categoryName}` : ''}
                </Text>
                {hasPhoto && <PhotoIcon color={tokens.textMuted} />}
                {hasDebt && <PeopleIcon color={tokens.textMuted} />}
              </View>

              {!selectMode && (
                <View style={styles.cardActions}>
                  <Pressable
                    onPress={(e) => {
                      e.stopPropagation();
                      openEdit(t);
                    }}
                    style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}
                  >
                    <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 11 }}>{tr('common.edit')}</Text>
                  </Pressable>
                  {isExpense && (
                    <Pressable
                      onPress={(e) => {
                        e.stopPropagation();
                        openDetail(t, { expandSplit: true });
                      }}
                      style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}
                    >
                      <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 11 }}>{tr('transactions.splitBtn')}</Text>
                    </Pressable>
                  )}
                  <Pressable
                    onPress={(e) => {
                      e.stopPropagation();
                      handleDeleteOne(t.id);
                    }}
                    style={[styles.smallBtn, { backgroundColor: pendingDeleteId === t.id ? tokens.coral : tokens.cardAlt }]}
                  >
                    <Text
                      style={{
                        color: pendingDeleteId === t.id ? tokens.accentText : tokens.coral,
                        fontFamily: fontFamily.semibold,
                        fontSize: 11,
                      }}
                    >
                      {pendingDeleteId === t.id ? tr('common.confirmQuestion') : tr('common.delete')}
                    </Text>
                  </Pressable>
                </View>
              )}
            </View>
          </Pressable>
        );
      })}

      {selectable && selectMode && (
        <View style={[styles.bulkBar, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5 }}>
            {selectedIds.size === 0 ? tr('transactions.tapToSelect') : `${selectedIds.size} ${tr('transactions.selected')}`}
          </Text>
          <Pressable
            onPress={handleBulkDelete}
            disabled={selectedIds.size === 0 || bulkBusy}
            style={[
              styles.bulkDeleteBtn,
              {
                backgroundColor: bulkConfirm ? tokens.coral : tokens.cardAlt,
                opacity: selectedIds.size === 0 ? 0.5 : 1,
              },
            ]}
          >
            <Text
              style={{
                color: bulkConfirm ? tokens.accentText : tokens.coral,
                fontFamily: fontFamily.bold,
                fontSize: 13,
              }}
            >
              {bulkConfirm
                ? `${tr('transactions.confirmDelete')} (${selectedIds.size})?`
                : `${tr('common.delete')}${selectedIds.size ? ` (${selectedIds.size})` : ''}`}
            </Text>
          </Pressable>
        </View>
      )}

      <Modal visible={editing !== null} transparent animationType="fade" onRequestClose={closeEdit}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.border }]}>
            <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 16, marginBottom: 14 }}>
              {tr('transactions.editTitle')}
            </Text>

            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginBottom: 6 }}>
              {tr('transactions.amountLabel')}
            </Text>
            <TextInput
              value={editAmount}
              onChangeText={setEditAmount}
              keyboardType="numeric"
              style={[styles.modalInput, { color: tokens.text, borderColor: tokens.border }]}
            />

            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginTop: 12, marginBottom: 6 }}>
              {tr('transactions.noteLabel')}
            </Text>
            <TextInput
              value={editNote}
              onChangeText={setEditNote}
              placeholder={tr('transactions.noteFieldPlaceholder')}
              placeholderTextColor={tokens.textMuted}
              style={[styles.modalInput, { color: tokens.text, borderColor: tokens.border }]}
            />

            {categories.length > 0 && (
              <>
                <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginTop: 12, marginBottom: 6 }}>
                  {tr('transactions.categoryLabel')}
                </Text>
                <View style={styles.chipRow}>
                  {categories.map((cat, i) => {
                    const active = editCategoryId === cat.id;
                    return (
                      <Pressable
                        key={cat.id}
                        onPress={() => setEditCategoryId(cat.id)}
                        style={[styles.chip, { backgroundColor: active ? tokens.accent : tokens.card }]}
                      >
                        {!active && <View style={[styles.categoryDot, { backgroundColor: categoryColor(i, tokens) }]} />}
                        <Text
                          style={{
                            color: active ? tokens.accentText : tokens.text,
                            fontFamily: fontFamily.semibold,
                            fontSize: 12.5,
                          }}
                        >
                          {cat.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            )}

            {editError && (
              <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 12.5, marginTop: 12 }}>
                {editError}
              </Text>
            )}

            <View style={styles.modalActions}>
              <Pressable onPress={closeEdit} style={[styles.modalBtn, { backgroundColor: tokens.card }]}>
                <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>{tr('common.cancel')}</Text>
              </Pressable>
              <Pressable
                onPress={saveEdit}
                disabled={editSaving}
                style={[styles.modalBtn, { backgroundColor: tokens.accent, opacity: editSaving ? 0.6 : 1 }]}
              >
                <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 14 }}>
                  {editSaving ? tr('common.saving') : tr('common.save')}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={detail !== null} transparent animationType="fade" onRequestClose={closeDetail}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, styles.detailCard, { backgroundColor: tokens.bg, borderColor: tokens.border }]}>
            {detail && (
              <ScrollView showsVerticalScrollIndicator={false}>
                <View style={styles.detailHeader}>
                  <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 16 }}>
                    {tr('transactions.detailTitle')}
                  </Text>
                  <Pressable onPress={closeDetail}>
                    <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.semibold, fontSize: 13 }}>{tr('common.close')}</Text>
                  </Pressable>
                </View>

                <Text
                  style={{
                    color: isCredit(detail.type) ? tokens.greenFg : tokens.text,
                    fontFamily: fontFamily.regular,
                    fontSize: 34,
                    marginTop: 6,
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {isCredit(detail.type) ? '+' : '−'}
                  {detail.amount}
                  <Text style={{ color: tokens.textMuted, fontSize: 16, fontFamily: fontFamily.medium }}> {tr('common.czk')}</Text>
                </Text>
                <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13, marginTop: 4 }}>
                  {detail.transaction_date} · {categoryOrTypeLabel(detail, tr)}
                </Text>
                {detail.note && (
                  <Text style={{ color: tokens.text, fontFamily: fontFamily.medium, fontSize: 14, marginTop: 8 }}>
                    {detail.note}
                  </Text>
                )}

                {detail.receipt_photo_url && (
                  <View style={{ marginTop: 16 }}>
                    <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginBottom: 6 }}>
                      {tr('transactions.receiptPhotoLabel')}
                    </Text>
                    {detailPhotoLoading && (
                      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5 }}>
                        {tr('common.loading')}
                      </Text>
                    )}
                    {detailPhotoError && (
                      <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 12.5 }}>
                        {detailPhotoError}
                      </Text>
                    )}
                    {detailPhotoUrl && (
                      <Pressable onPress={openPhotoFullSize}>
                        <Image source={{ uri: detailPhotoUrl }} style={styles.detailPhoto} resizeMode="cover" />
                        {Platform.OS === 'web' && (
                          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11, marginTop: 5 }}>
                            {tr('transactions.viewFullPhoto')}
                          </Text>
                        )}
                      </Pressable>
                    )}
                  </View>
                )}

                {(detailDebtsLoading || detailDebts.length > 0) && (
                  <View style={{ marginTop: 16 }}>
                    <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginBottom: 6 }}>
                      {tr('transactions.existingDebtsLabel')}
                    </Text>
                    {detailDebtsLoading ? (
                      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5 }}>
                        {tr('common.loading')}
                      </Text>
                    ) : (
                      detailDebts.map((d) => (
                        <View key={d.id} style={[styles.existingDebtRow, { borderColor: tokens.border }]}>
                          <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13 }}>
                            {d.owed_by_name}
                          </Text>
                          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5 }}>
                            {d.amount} {tr('common.czk')} · {debtStatusLabel(d.status)}
                          </Text>
                        </View>
                      ))
                    )}
                  </View>
                )}

                {detail.type === 'EXPENSE' && (
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
                            onPress={handleSplitEvenly}
                            disabled={splitTotalNumeric <= 0}
                            style={[
                              styles.splitAddPersonBtn,
                              { backgroundColor: tokens.cardAlt, opacity: splitTotalNumeric > 0 ? 1 : 0.5 },
                            ]}
                          >
                            <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                              {tr('home.splitEvenlyBtn')}
                            </Text>
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
                              <Pressable onPress={() => removeSplitPerson(p.id)} hitSlop={8}>
                                <Text style={{ color: tokens.coral, fontFamily: fontFamily.bold, fontSize: 16 }}>×</Text>
                              </Pressable>
                            )}
                          </View>
                        ))}
                        <Pressable
                          onPress={addSplitPerson}
                          style={[styles.splitAddPersonBtn, { backgroundColor: tokens.cardAlt }]}
                        >
                          <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                            {tr('home.addPersonBtn')}
                          </Text>
                        </Pressable>

                        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5 }}>
                          {tr('home.splitHint')}
                        </Text>

                        {splitError && (
                          <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 12.5 }}>
                            {splitError}
                          </Text>
                        )}

                        {splitShareLinks.length > 0 && (
                          <View style={[styles.shareBox, { backgroundColor: tokens.greenBg }]}>
                            <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                              {tr('home.shareLinkCreated')}
                            </Text>
                            {splitShareLinks.map((link, idx) => (
                              <View key={link.link} style={styles.shareLinkRow}>
                                <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.semibold, fontSize: 12 }}>
                                  {link.name}
                                </Text>
                                <Text
                                  selectable
                                  numberOfLines={1}
                                  style={{ color: tokens.greenFg, fontFamily: fontFamily.medium, fontSize: 12 }}
                                >
                                  {link.link}
                                </Text>
                                <Pressable
                                  onPress={() => copySplitLink(idx)}
                                  style={[styles.copyBtn, { backgroundColor: tokens.card }]}
                                >
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
                            {splitSaving ? tr('common.saving') : tr('common.save')}
                          </Text>
                        </Pressable>
                      </View>
                    )}
                  </>
                )}

                <Pressable
                  onPress={() => {
                    closeDetail();
                    openEdit(detail);
                  }}
                  style={[styles.modalBtn, { backgroundColor: tokens.card, marginTop: 18 }]}
                >
                  <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>
                    {tr('transactions.editTitle')}
                  </Text>
                </Pressable>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      <Modal visible={mergeOffer !== null} transparent animationType="fade" onRequestClose={() => setMergeOffer(null)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, styles.detailCard, { backgroundColor: tokens.bg, borderColor: tokens.border }]}>
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
                      <Pressable
                        onPress={() => setMergeChoice(key, true)}
                        style={[styles.mergeChoiceBtn, { backgroundColor: merging ? tokens.accent : tokens.cardAlt }]}
                      >
                        <Text
                          style={{
                            color: merging ? tokens.accentText : tokens.text,
                            fontFamily: fontFamily.semibold,
                            fontSize: 12.5,
                          }}
                        >
                          {tr('debts.mergeOfferMerge')}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => setMergeChoice(key, false)}
                        style={[styles.mergeChoiceBtn, { backgroundColor: !merging ? tokens.accent : tokens.cardAlt }]}
                      >
                        <Text
                          style={{
                            color: !merging ? tokens.accentText : tokens.text,
                            fontFamily: fontFamily.semibold,
                            fontSize: 12.5,
                          }}
                        >
                          {tr('debts.mergeOfferKeepSeparate')}
                        </Text>
                      </Pressable>
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
                  <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 14 }}>
                    {tr('debts.mergeOfferContinue')}
                  </Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 10,
  },
  // Compact card (Pavel: "make it more compact so i can fit more
  // transactions to one page") — 2 rows instead of 3: name+amount, then
  // date/category/icons alongside the action buttons on one wrapping row,
  // instead of the buttons getting a row of their own.
  card: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginBottom: 6,
    gap: 4,
  },
  row1: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  row2: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1, minWidth: 0 },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardActions: { flexDirection: 'row', gap: 5, flexWrap: 'wrap' },
  smallBtn: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: 8 },
  bulkBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: 1,
  },
  bulkDeleteBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10 },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 18,
    borderWidth: 1,
    padding: 20,
  },
  detailCard: { maxHeight: '85%' },
  detailHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  detailPhoto: { width: '100%', height: 220, borderRadius: 12 },
  existingDebtRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  modalInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  categoryDot: { width: 7, height: 7, borderRadius: 4 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
  },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 20 },
  modalBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  splitToggle: { alignItems: 'center', paddingVertical: 2, marginTop: 18 },
  splitPanel: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 8, marginTop: 8 },
  splitInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  splitPersonRow: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  splitEvenlyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  splitAddPersonBtn: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9 },
  shareBox: { borderRadius: 14, padding: 12, gap: 8 },
  shareLinkRow: { gap: 4 },
  copyBtn: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9 },
  splitSaveBtn: { paddingVertical: 13, borderRadius: 12, alignItems: 'center' },
  mergeOfferRow: { borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 10, gap: 6 },
  mergeChoiceRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  mergeChoiceBtn: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center' },
});
