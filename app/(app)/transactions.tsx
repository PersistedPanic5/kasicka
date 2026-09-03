import { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth-context';
import { useAppData } from '@/lib/use-app-data';
import { useLanguage } from '@/lib/language-context';
import {
  createDebtsForSplit,
  emptySplitPerson,
  splitEvenly,
  splitPeopleSum,
  validSplitPeople,
  type SplitPerson,
} from '@/lib/split-people';
import type { DebtStatus } from '@/types/database';

type TransactionRow = {
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

type TypeFilter = 'ALL' | 'EXPENSE' | 'INCOME' | 'OTHER';

/** Small stroke-based icon badges shown inline in a row's subtitle — matches
 * the stroke/viewBox conventions already used for the hamburger and
 * quick-entry icons in app/(app)/_layout.tsx. */
function PhotoIcon({ size = 13, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M4 8h3l2-2h6l2 2h3v11H4z" />
      <Circle cx="12" cy="13.2" r="3" />
    </Svg>
  );
}
function PeopleIcon({ size = 13, color }: { size?: number; color: string }) {
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
 * Real transaction list — chronological, most recent first.
 *
 * Delete/edit (Pavel's request, Phase 1.5): delete is a soft-delete —
 * status flips to 'VOID' (a state the schema already had, see
 * supabase/migrations/0001_initial_schema.sql) rather than a hard row
 * delete, so a debt's linked transaction_id never dangles and nothing is
 * unrecoverable from the DB side. Since this list already filters to
 * status='PAID', a voided row just disappears on reload — same effect as
 * deleting, from here. Edit covers amount/category/note (the fields
 * someone would realistically fix after the fact); the date isn't
 * editable yet.
 *
 * Both single-row delete and the bulk "Select" mode use a two-tap confirm
 * (button relabels to "Confirm?" for ~3s) instead of a native confirm()
 * dialog, matching the rest of the app's inline-feedback style (see
 * ExpenseEntryForm's copy-link button).
 *
 * When a transaction has a note, it reads as the row's name (the note is
 * what you actually typed to describe it) with the category demoted to
 * the subtitle line — otherwise the category name carries the row, same
 * as before notes existed.
 *
 * Search/filter + detail view (Pavel's request): a search box plus two
 * chip-filter rows (type, category), styled after Debts' filterRow/
 * filterChip pattern rather than inventing a new filter UI. Rows moved
 * from a flat bottom-border list to Debts' card/cardTop/cardActions
 * layout at the same time — partly for visual consistency, partly
 * because a flat single row was exactly the shape that caused the
 * Czech-language column-squeeze bug on the Debts page (see that file's
 * `card` comment); stacking actions onto their own wrapping row sidesteps
 * it here too now that a third action button (Split) is joining Edit/
 * Delete.
 *
 * Tapping a row (outside of Select mode) opens a new detail modal — the
 * receipt photo (if any) wasn't visible ANYWHERE before this, only ever
 * uploaded and stored; the detail view is where it's actually shown,
 * fetched as a short-lived signed URL since the "receipts" Storage bucket
 * is private (supabase/migrations/0004_recurring_and_push.sql). The same
 * modal is also where "create a debt from this existing bill" lives — a
 * small "Split" button on the row (and a toggle inside the detail modal
 * itself) both open it, reusing the exact same fields/copy as the split
 * panel on Home (components/ExpenseEntryForm.tsx: who owes / how much /
 * message) so creating a debt looks and behaves identically whether it
 * happens at the moment of entry or after the fact. Existing debts
 * already linked to a transaction are listed read-only above that form,
 * both so Pavel doesn't accidentally double-split a bill and because one
 * bill can legitimately be split among more than one person over time.
 */
export default function Transactions() {
  const { tokens } = useTheme();
  // Aliased to `tr` — this file already uses `t` as the loop/row variable
  // for each transaction (see transactions.map((t) => ...) below).
  const { t: tr } = useLanguage();
  const { user } = useAuth();
  const { categories } = useAppData();
  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [debtLinkedIds, setDebtLinkedIds] = useState<Set<string>>(new Set());

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

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');

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
  const [splitSaving, setSplitSaving] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);
  const [splitShareLinks, setSplitShareLinks] = useState<{ name: string; link: string }[]>([]);
  const [splitCopiedIdx, setSplitCopiedIdx] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('transactions')
      .select(
        'id, transaction_date, type, amount, note, status, category_id, account_id, receipt_photo_url, categories(name)'
      )
      .eq('status', 'PAID')
      .order('transaction_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(100);
    const rows = (data as unknown as TransactionRow[]) ?? [];
    setTransactions(rows);
    setLoading(false);

    if (rows.length > 0) {
      const { data: debtRows } = await supabase
        .from('debts')
        .select('transaction_id')
        .in('transaction_id', rows.map((r) => r.id));
      setDebtLinkedIds(new Set((debtRows ?? []).map((d) => d.transaction_id)));
    } else {
      setDebtLinkedIds(new Set());
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const typeLabel: Record<string, string> = {
    EXPENSE: tr('transactions.typeExpense'),
    INCOME: tr('transactions.typeIncome'),
    RESERVE_TRANSFER: tr('transactions.typeReserveTransfer'),
    PAYMENT_FROM_RESERVE: tr('transactions.typeReservePayment'),
    DEBT_SETTLEMENT_CREDIT: tr('transactions.typeDebtSettled'),
  };

  const isCredit = (type: string) => type === 'INCOME' || type === 'DEBT_SETTLEMENT_CREDIT';

  const filteredTransactions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return transactions.filter((t) => {
      if (typeFilter === 'EXPENSE' && t.type !== 'EXPENSE') return false;
      if (typeFilter === 'INCOME' && t.type !== 'INCOME') return false;
      if (typeFilter === 'OTHER' && (t.type === 'EXPENSE' || t.type === 'INCOME')) return false;
      if (categoryFilter !== 'ALL' && t.category_id !== categoryFilter) return false;
      if (q) {
        const categoryName = t.categories?.name ?? typeLabel[t.type] ?? t.type;
        const haystack = `${t.note ?? ''} ${categoryName}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, search, typeFilter, categoryFilter]);

  const typeFilters: { key: TypeFilter; label: string }[] = [
    { key: 'ALL', label: tr('transactions.filterAll') },
    { key: 'EXPENSE', label: tr('transactions.typeExpense') },
    { key: 'INCOME', label: tr('transactions.typeIncome') },
    { key: 'OTHER', label: tr('transactions.filterOther') },
  ];
  const categoryFilters = [{ id: 'ALL', name: tr('transactions.filterAll') }, ...categories.map((c) => ({ id: c.id, name: c.name }))];

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
    load();
  }

  async function handleDeleteOne(id: string) {
    if (pendingDeleteId !== id) {
      setPendingDeleteId(id);
      setTimeout(() => setPendingDeleteId((cur) => (cur === id ? null : cur)), 3000);
      return;
    }
    setPendingDeleteId(null);
    await supabase.from('transactions').update({ status: 'VOID' }).eq('id', id);
    load();
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
    load();
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

  // ── Split-people helpers (multi-person rebuild, shared math with
  // components/ExpenseEntryForm.tsx via lib/split-people.ts) ────────────
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

  async function saveSplitDebt() {
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

    setSplitSaving(true);
    setSplitError(null);
    const { links, error } = await createDebtsForSplit({
      ownerId: user.id,
      transactionId: detail.id,
      targetAccountId: detail.account_id,
      message: splitMessage.trim() || null,
      people: validPeople,
    });

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
    <View style={{ flex: 1 }}>
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

      <View style={[styles.searchWrap, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
        <Svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={tokens.textMuted} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <Circle cx="11" cy="11" r="7" />
          <Path d="m21 21-4.3-4.3" />
        </Svg>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder={tr('transactions.searchPlaceholder')}
          placeholderTextColor={tokens.textMuted}
          style={[styles.searchInput, { color: tokens.text }]}
        />
      </View>

      <View style={styles.filterRow}>
        {typeFilters.map((f) => {
          const active = typeFilter === f.key;
          return (
            <Pressable
              key={f.key}
              onPress={() => setTypeFilter(f.key)}
              style={[styles.filterChip, { backgroundColor: active ? tokens.accent : tokens.card }]}
            >
              <Text style={{ color: active ? tokens.accentText : tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                {f.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {categories.length > 0 && (
        <View style={[styles.filterRow, { marginTop: 4 }]}>
          {categoryFilters.map((c) => {
            const active = categoryFilter === c.id;
            return (
              <Pressable
                key={c.id}
                onPress={() => setCategoryFilter(c.id)}
                style={[styles.filterChip, { backgroundColor: active ? tokens.accent : tokens.card }]}
              >
                <Text style={{ color: active ? tokens.accentText : tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                  {c.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      <ScrollView style={{ flex: 1, marginTop: 14 }} contentContainerStyle={{ paddingBottom: selectMode ? 90 : 40 }}>
        {loading && (
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium }}>{tr('common.loading')}</Text>
        )}
        {!loading && transactions.length === 0 && (
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 14 }}>
            {tr('transactions.noneYet')}
          </Text>
        )}
        {!loading && transactions.length > 0 && filteredTransactions.length === 0 && (
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 14 }}>
            {tr('transactions.noMatches')}
          </Text>
        )}
        {filteredTransactions.map((t) => {
          const categoryName = t.categories?.name ?? typeLabel[t.type] ?? t.type;
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
              <View style={styles.cardTop}>
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
                    {selected && <Text style={{ color: tokens.accentText, fontSize: 12, fontFamily: fontFamily.bold }}>✓</Text>}
                  </View>
                )}

                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14.5 }}>
                    {primaryName}
                  </Text>
                  <View style={styles.subtitleRow}>
                    <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5 }}>
                      {t.transaction_date}
                      {showCategoryAsSubtitle ? ` · ${categoryName}` : ''}
                    </Text>
                    {hasPhoto && <PhotoIcon color={tokens.textMuted} />}
                    {hasDebt && <PeopleIcon color={tokens.textMuted} />}
                  </View>
                </View>

                <Text
                  style={{
                    color: isCredit(t.type) ? tokens.greenFg : tokens.text,
                    fontFamily: fontFamily.bold,
                    fontSize: 15,
                  }}
                >
                  {isCredit(t.type) ? '+' : '−'}
                  {t.amount} CZK
                </Text>
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
                    <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12 }}>{tr('common.edit')}</Text>
                  </Pressable>
                  {isExpense && (
                    <Pressable
                      onPress={(e) => {
                        e.stopPropagation();
                        openDetail(t, { expandSplit: true });
                      }}
                      style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}
                    >
                      <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12 }}>{tr('transactions.splitBtn')}</Text>
                    </Pressable>
                  )}
                  <Pressable
                    onPress={(e) => {
                      e.stopPropagation();
                      handleDeleteOne(t.id);
                    }}
                    style={[
                      styles.smallBtn,
                      { backgroundColor: pendingDeleteId === t.id ? tokens.coral : tokens.cardAlt },
                    ]}
                  >
                    <Text
                      style={{
                        color: pendingDeleteId === t.id ? tokens.accentText : tokens.coral,
                        fontFamily: fontFamily.semibold,
                        fontSize: 12,
                      }}
                    >
                      {pendingDeleteId === t.id ? tr('common.confirmQuestion') : tr('common.delete')}
                    </Text>
                  </Pressable>
                </View>
              )}
            </Pressable>
          );
        })}
      </ScrollView>

      {selectMode && (
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
                  {categories.map((cat) => {
                    const active = editCategoryId === cat.id;
                    return (
                      <Pressable
                        key={cat.id}
                        onPress={() => setEditCategoryId(cat.id)}
                        style={[styles.chip, { backgroundColor: active ? tokens.accent : tokens.card }]}
                      >
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
                  }}
                >
                  {isCredit(detail.type) ? '+' : '−'}
                  {detail.amount}
                  <Text style={{ color: tokens.textMuted, fontSize: 16, fontFamily: fontFamily.medium }}> {tr('common.czk')}</Text>
                </Text>
                <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13, marginTop: 4 }}>
                  {detail.transaction_date} · {detail.categories?.name ?? typeLabel[detail.type] ?? detail.type}
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
                        {/* Amount + message on top, people list at the end —
                            same layout as Record Expense's split panel
                            (lib/split-people.ts shares the math). */}
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
                            <TextInput
                              value={p.name}
                              onChangeText={(v) => updateSplitPerson(p.id, 'name', v)}
                              placeholder={tr('home.whoOwesPlaceholder')}
                              placeholderTextColor={tokens.textMuted}
                              style={[styles.splitInput, { color: tokens.text, borderColor: tokens.border, flex: 2 }]}
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
                          onPress={saveSplitDebt}
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
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  searchInput: { flex: 1, paddingVertical: 10, fontSize: 14 },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  filterChip: { paddingHorizontal: 13, paddingVertical: 8, borderRadius: 10 },
  // Cards, not flat bordered rows — see the file doc comment on why this
  // moved to match Debts' card/cardTop/cardActions layout.
  card: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
    gap: 10,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardActions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  smallBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9 },
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
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 },
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
});
