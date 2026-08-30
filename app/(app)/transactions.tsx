import { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { supabase } from '@/lib/supabase';
import { useAppData } from '@/lib/use-app-data';
import { useLanguage } from '@/lib/language-context';

type TransactionRow = {
  id: string;
  transaction_date: string;
  type: string;
  amount: number;
  note: string | null;
  status: string;
  category_id: string | null;
  categories: { name: string } | null;
};

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
 */
export default function Transactions() {
  const { tokens } = useTheme();
  // Aliased to `tr` — this file already uses `t` as the loop variable for
  // each transaction row (see transactions.map((t) => ...) below).
  const { t: tr } = useLanguage();
  const { categories } = useAppData();
  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [loading, setLoading] = useState(true);

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

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('transactions')
      .select('id, transaction_date, type, amount, note, status, category_id, categories(name)')
      .eq('status', 'PAID')
      .order('transaction_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(100);
    setTransactions((data as unknown as TransactionRow[]) ?? []);
    setLoading(false);
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

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: selectMode ? 90 : 40 }}>
        {loading && (
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium }}>{tr('common.loading')}</Text>
        )}
        {!loading && transactions.length === 0 && (
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 14 }}>
            {tr('transactions.noneYet')}
          </Text>
        )}
        {transactions.map((t) => {
          const categoryName = t.categories?.name ?? typeLabel[t.type] ?? t.type;
          const primaryName = t.note?.trim() || categoryName;
          const showCategoryAsSubtitle = Boolean(t.note?.trim()) && categoryName !== primaryName;
          const selected = selectedIds.has(t.id);
          return (
            <Pressable
              key={t.id}
              onPress={() => (selectMode ? toggleSelected(t.id) : undefined)}
              style={[styles.row, { borderBottomColor: tokens.border }]}
            >
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

              <View style={{ flex: 1 }}>
                <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14.5 }}>
                  {primaryName}
                </Text>
                <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5, marginTop: 2 }}>
                  {t.transaction_date}
                  {showCategoryAsSubtitle ? ` · ${categoryName}` : ''}
                </Text>
              </View>

              <Text
                style={{
                  color: isCredit(t.type) ? tokens.greenFg : tokens.text,
                  fontFamily: fontFamily.bold,
                  fontSize: 15,
                  marginRight: selectMode ? 0 : 10,
                }}
              >
                {isCredit(t.type) ? '+' : '−'}
                {t.amount} CZK
              </Text>

              {!selectMode && (
                <View style={styles.rowActions}>
                  <Pressable onPress={() => openEdit(t)} style={[styles.rowActionBtn, { backgroundColor: tokens.card }]}>
                    <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 11.5 }}>{tr('common.edit')}</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => handleDeleteOne(t.id)}
                    style={[
                      styles.rowActionBtn,
                      { backgroundColor: pendingDeleteId === t.id ? tokens.coral : tokens.card },
                    ]}
                  >
                    <Text
                      style={{
                        color: pendingDeleteId === t.id ? tokens.accentText : tokens.coral,
                        fontFamily: fontFamily.semibold,
                        fontSize: 11.5,
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    gap: 8,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 4,
  },
  rowActions: { flexDirection: 'row', gap: 6 },
  rowActionBtn: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8 },
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
  modalInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 20 },
  modalBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
});
