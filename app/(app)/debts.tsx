import { useCallback, useEffect, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth-context';
import type { DebtStatus } from '@/types/database';

type DebtRow = {
  id: string;
  owed_by_name: string;
  amount: number;
  status: DebtStatus;
  share_token: string;
  transaction_id: string;
  target_account_id: string;
  message: string | null;
  created_at: string;
};

/**
 * Real debts list — debts-ledger-requirements.md "Settle-up state
 * machine": three sections (OUTSTANDING / awaiting-your-confirmation /
 * SETTLED), since a CLAIMED_PAID debt is the debtor's claim, not proof —
 * Pavel checks his bank statement and explicitly confirms before the
 * budget credit lands. "Confirm settled" is the one action here that
 * writes anything: it inserts a DEBT_SETTLEMENT_CREDIT transaction in the
 * original expense's category, dated today, and marks the debt SETTLED.
 *
 * Delete/edit (Pavel's request, Phase 1.5): unlike transactions, a debt
 * has no VOID state in the schema — deleting one here is a real row
 * delete. It only removes the debt-tracking row itself; the linked
 * expense transaction (transaction_id) is untouched, so the money you
 * actually spent stays on the books, you just stop tracking that someone
 * owes you part of it back. Edit covers who owes you, how much, and the
 * message shown on their share link/QR — not which transaction it's
 * linked to. Both single and bulk delete use a two-tap confirm (button
 * relabels to "Confirm?" for ~3s) rather than a native confirm() dialog.
 */
export default function Debts() {
  const { tokens } = useTheme();
  const { user } = useAuth();
  const [debts, setDebts] = useState<DebtRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const [editing, setEditing] = useState<DebtRow | null>(null);
  const [editName, setEditName] = useState('');
  const [editAmount, setEditAmount] = useState('');
  const [editMessage, setEditMessage] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('debts')
      .select('id, owed_by_name, amount, status, share_token, transaction_id, target_account_id, message, created_at')
      .order('created_at', { ascending: false });
    setDebts(data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function shareLink(token: string) {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      return `${window.location.origin}/d/${token}`;
    }
    return `/d/${token}`;
  }

  async function copyLink(debt: DebtRow) {
    const link = shareLink(debt.share_token);
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(link);
      setCopiedId(debt.id);
      setTimeout(() => setCopiedId(null), 1500);
    }
  }

  async function confirmSettled(debt: DebtRow) {
    if (!user) return;
    setBusyId(debt.id);

    const { data: original } = await supabase
      .from('transactions')
      .select('category_id, account_id')
      .eq('id', debt.transaction_id)
      .maybeSingle();

    const today = new Date().toISOString().slice(0, 10);
    const { data: credit, error: creditError } = await supabase
      .from('transactions')
      .insert({
        owner_id: user.id,
        budget_month: `${today.slice(0, 7)}-01`,
        transaction_date: today,
        type: 'DEBT_SETTLEMENT_CREDIT',
        category_id: original?.category_id ?? null,
        account_id: original?.account_id ?? debt.target_account_id,
        amount: debt.amount,
        note: `Settled: ${debt.owed_by_name}`,
        source: 'DEBT_SETTLEMENT',
      })
      .select('id')
      .single();

    if (!creditError && credit) {
      await supabase
        .from('debts')
        .update({
          status: 'SETTLED',
          settled_at: new Date().toISOString(),
          settlement_transaction_id: credit.id,
        })
        .eq('id', debt.id);
    }

    setBusyId(null);
    load();
  }

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
    await supabase.from('debts').delete().in('id', Array.from(selectedIds));
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
    await supabase.from('debts').delete().eq('id', id);
    load();
  }

  function openEdit(debt: DebtRow) {
    setEditing(debt);
    setEditName(debt.owed_by_name);
    setEditAmount(String(debt.amount));
    setEditMessage(debt.message ?? '');
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
      setEditError('Enter an amount greater than 0.');
      return;
    }
    if (!editName.trim()) {
      setEditError('Who owes you this?');
      return;
    }
    setEditSaving(true);
    setEditError(null);
    const { error } = await supabase
      .from('debts')
      .update({
        owed_by_name: editName.trim(),
        amount: numericAmount,
        message: editMessage.trim() || null,
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

  const outstanding = debts.filter((d) => d.status === 'OUTSTANDING');
  const awaitingConfirmation = debts.filter((d) => d.status === 'CLAIMED_PAID');
  const settled = debts.filter((d) => d.status === 'SETTLED');

  function DebtCard({ debt, action }: { debt: DebtRow; action?: 'settle' }) {
    const selected = selectedIds.has(debt.id);
    return (
      <Pressable
        key={debt.id}
        onPress={() => (selectMode ? toggleSelected(debt.id) : undefined)}
        style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.border }]}
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
          <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 15 }}>{debt.owed_by_name}</Text>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5, marginTop: 2 }}>
            {debt.amount} CZK
          </Text>
        </View>

        {!selectMode && (
          <View style={styles.cardActions}>
            {debt.status !== 'SETTLED' && (
              <Pressable onPress={() => copyLink(debt)} style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}>
                <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12 }}>
                  {copiedId === debt.id ? 'Copied' : 'Copy link'}
                </Text>
              </Pressable>
            )}
            {action === 'settle' && (
              <Pressable
                onPress={() => confirmSettled(debt)}
                disabled={busyId === debt.id}
                style={[styles.smallBtn, { backgroundColor: tokens.accent, opacity: busyId === debt.id ? 0.6 : 1 }]}
              >
                <Text style={{ color: tokens.accentText, fontFamily: fontFamily.semibold, fontSize: 12 }}>
                  Confirm settled
                </Text>
              </Pressable>
            )}
            <Pressable onPress={() => openEdit(debt)} style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}>
              <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12 }}>Edit</Text>
            </Pressable>
            <Pressable
              onPress={() => handleDeleteOne(debt.id)}
              style={[styles.smallBtn, { backgroundColor: pendingDeleteId === debt.id ? tokens.coral : tokens.cardAlt }]}
            >
              <Text
                style={{
                  color: pendingDeleteId === debt.id ? tokens.accentText : tokens.coral,
                  fontFamily: fontFamily.semibold,
                  fontSize: 12,
                }}
              >
                {pendingDeleteId === debt.id ? 'Confirm?' : 'Delete'}
              </Text>
            </Pressable>
          </View>
        )}
      </Pressable>
    );
  }

  function Section({ title, items, action, emptyNote }: {
    title: string;
    items: DebtRow[];
    action?: 'settle';
    emptyNote: string;
  }) {
    return (
      <View style={styles.section}>
        <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 15, marginBottom: 10 }}>
          {title} {items.length > 0 && `(${items.length})`}
        </Text>
        {items.length === 0 ? (
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13 }}>{emptyNote}</Text>
        ) : (
          items.map((d) => <DebtCard key={d.id} debt={d} action={action} />)
        )}
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.topBar}>
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5 }}>
          {selectMode && selectedIds.size > 0 ? `${selectedIds.size} selected` : ' '}
        </Text>
        <Pressable onPress={toggleSelectMode}>
          <Text style={{ color: tokens.accent, fontFamily: fontFamily.semibold, fontSize: 13 }}>
            {selectMode ? 'Cancel' : 'Select'}
          </Text>
        </Pressable>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: selectMode ? 90 : 40 }}>
        {loading ? (
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium }}>Loading…</Text>
        ) : (
          <>
            <Section
              title="Awaiting your confirmation"
              items={awaitingConfirmation}
              action="settle"
              emptyNote="Nothing marked as paid yet."
            />
            <Section title="Outstanding" items={outstanding} emptyNote="Nobody owes you anything right now." />
            <Section title="Settled" items={settled} emptyNote="No settled debts yet." />
          </>
        )}
      </ScrollView>

      {selectMode && (
        <View style={[styles.bulkBar, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5 }}>
            {selectedIds.size === 0 ? 'Tap debts to select' : `${selectedIds.size} selected`}
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
              {bulkConfirm ? `Confirm delete (${selectedIds.size})?` : `Delete${selectedIds.size ? ` (${selectedIds.size})` : ''}`}
            </Text>
          </Pressable>
        </View>
      )}

      <Modal visible={editing !== null} transparent animationType="fade" onRequestClose={closeEdit}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.border }]}>
            <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 16, marginBottom: 14 }}>
              Edit debt
            </Text>

            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginBottom: 6 }}>
              Who owes you
            </Text>
            <TextInput
              value={editName}
              onChangeText={setEditName}
              style={[styles.modalInput, { color: tokens.text, borderColor: tokens.border }]}
            />

            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginTop: 12, marginBottom: 6 }}>
              Amount (CZK)
            </Text>
            <TextInput
              value={editAmount}
              onChangeText={setEditAmount}
              keyboardType="numeric"
              style={[styles.modalInput, { color: tokens.text, borderColor: tokens.border }]}
            />

            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginTop: 12, marginBottom: 6 }}>
              Message on their link/QR
            </Text>
            <TextInput
              value={editMessage}
              onChangeText={setEditMessage}
              placeholder="Optional"
              placeholderTextColor={tokens.textMuted}
              style={[styles.modalInput, { color: tokens.text, borderColor: tokens.border }]}
            />

            {editError && (
              <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 12.5, marginTop: 12 }}>
                {editError}
              </Text>
            )}

            <View style={styles.modalActions}>
              <Pressable onPress={closeEdit} style={[styles.modalBtn, { backgroundColor: tokens.card }]}>
                <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={saveEdit}
                disabled={editSaving}
                style={[styles.modalBtn, { backgroundColor: tokens.accent, opacity: editSaving ? 0.6 : 1 }]}
              >
                <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 14 }}>
                  {editSaving ? 'Saving…' : 'Save'}
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
  section: { marginBottom: 28 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
    gap: 8,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardActions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' },
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
  modalInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 20 },
  modalBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
});
