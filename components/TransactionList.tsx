import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { supabase } from '@/lib/supabase';
import { useLanguage } from '@/lib/language-context';
import { TransactionEditor, type TransactionRow } from '@/components/TransactionEditor';
import type { EventRow } from '@/types/database';

// The row type lives with the editor now (it is the editor's input); kept
// re-exported here so existing imports from this file keep working.
export type { TransactionRow };

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
 * The real-transaction list — compact row rendering plus delete and bulk
 * select, shared between app/(app)/transactions.tsx (the full list, with
 * search/type/category filters and an optional bulk-select mode) and the
 * Overview per-category drill-down.
 *
 * Tapping a row, Edit or Split opens the one shared edit menu
 * (components/TransactionEditor.tsx) — the same menu the Debts page uses —
 * so every place edits a transaction identically. A row whose expense has
 * been split with people shows a "Split · waiting" / "Split · settled"
 * badge (settled = every linked debt is SETTLED).
 *
 * The caller owns loading/filtering the `transactions` array itself and
 * just hands the already-filtered rows in. `onChanged` is called after any
 * edit/delete/split so the caller reloads its own list.
 */
export function TransactionList({
  transactions,
  categories,
  accounts = [],
  events = [],
  monthStartDay,
  loading = false,
  emptyMessage,
  selectable = false,
  onChanged,
}: {
  transactions: TransactionRow[];
  categories: { id: string; name: string }[];
  /** Active accounts, for the editor's account picker. */
  accounts?: { id: string; name: string }[];
  /** All of the owner's events (active and archived) — archived ones stay
   * offered so a transaction already tagged with one keeps a real name. */
  events?: Pick<EventRow, 'id' | 'name' | 'active'>[];
  /** `profile.month_start_day` — see TransactionEditor. */
  monthStartDay?: number | null;
  loading?: boolean;
  emptyMessage: string;
  selectable?: boolean;
  onChanged: () => void;
}) {
  const { tokens } = useTheme();
  // Aliased to `tr` — `t` below is the loop variable for each transaction.
  const { t: tr } = useLanguage();

  // Per-transaction split summary for the card badge. `version` re-runs the
  // lookup after the editor creates a split.
  const [splitInfo, setSplitInfo] = useState<Map<string, { total: number; settled: number }>>(new Map());
  const [splitVersion, setSplitVersion] = useState(0);
  const idsKey = useMemo(() => transactions.map((row) => row.id).join(','), [transactions]);
  useEffect(() => {
    let cancelled = false;
    if (transactions.length === 0) {
      setSplitInfo(new Map());
      return;
    }
    supabase
      .from('debts')
      .select('transaction_id, status')
      .in('transaction_id', transactions.map((row) => row.id))
      .then(({ data }) => {
        if (cancelled) return;
        const next = new Map<string, { total: number; settled: number }>();
        for (const d of data ?? []) {
          const cur = next.get(d.transaction_id) ?? { total: 0, settled: 0 };
          cur.total += 1;
          if (d.status === 'SETTLED') cur.settled += 1;
          next.set(d.transaction_id, cur);
        }
        setSplitInfo(next);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, splitVersion]);

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ tx: TransactionRow; expandSplit: boolean } | null>(null);

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
        const split = splitInfo.get(t.id);
        const splitSettled = Boolean(split) && split!.settled === split!.total;
        return (
          <Pressable
            key={t.id}
            onPress={() => (selectMode ? toggleSelected(t.id) : setEditor({ tx: t, expandSplit: false }))}
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
                {split && (
                  <View style={[styles.splitBadge, { backgroundColor: splitSettled ? tokens.greenBg : tokens.amberBg }]}>
                    <PeopleIcon size={11} color={splitSettled ? tokens.greenFg : tokens.amberFg} />
                    <Text style={{ color: splitSettled ? tokens.greenFg : tokens.amberFg, fontFamily: fontFamily.semibold, fontSize: 10.5 }}>
                      {splitSettled ? tr('transactions.splitSettledBadge') : tr('transactions.splitWaitingBadge')}
                    </Text>
                  </View>
                )}
              </View>

              {!selectMode && (
                <View style={styles.cardActions}>
                  <Pressable
                    onPress={(e) => {
                      e.stopPropagation();
                      setEditor({ tx: t, expandSplit: false });
                    }}
                    style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}
                  >
                    <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 11 }}>{tr('common.edit')}</Text>
                  </Pressable>
                  {isExpense && (
                    <Pressable
                      onPress={(e) => {
                        e.stopPropagation();
                        setEditor({ tx: t, expandSplit: true });
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

      {editor && (
        <TransactionEditor
          key={editor.tx.id}
          transaction={editor.tx}
          categories={categories}
          accounts={accounts}
          events={events}
          monthStartDay={monthStartDay}
          expandSplit={editor.expandSplit}
          onClose={() => setEditor(null)}
          onChanged={() => {
            setSplitVersion((v) => v + 1);
            onChanged();
          }}
        />
      )}
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
  splitBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 7 },
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
});
