import { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth-context';
import { useLanguage } from '@/lib/language-context';
import { budgetMonthForDate } from '@/lib/budget-month';
import { buildMergedFromSnapshot, mergeDebtMessages } from '@/lib/debt-merge';
import { identityColorFor, withAlpha } from '@/lib/identity';
import type { DebtStatus, MergedDebtSnapshot } from '@/types/database';

type DebtRow = {
  id: string;
  owed_by_name: string;
  amount: number;
  status: DebtStatus;
  share_token: string;
  /** Null for a debt created by an earlier merge — see
   * supabase/migrations/0009_debts_merge_support.sql. */
  transaction_id: string | null;
  target_account_id: string;
  message: string | null;
  created_at: string;
  /** Set only on a debt created by merging others — what "Unmerge" (below)
   * recreates from. See supabase/migrations/0010_debts_unmerge_support.sql. */
  merged_from: MergedDebtSnapshot[] | null;
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
  const { t } = useLanguage();
  const { user } = useAuth();
  const [debts, setDebts] = useState<DebtRow[]>([]);
  const [monthStartDay, setMonthStartDay] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingUnmergeId, setPendingUnmergeId] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const [mergeModalOpen, setMergeModalOpen] = useState(false);
  const [mergeName, setMergeName] = useState('');
  const [mergeAmount, setMergeAmount] = useState('');
  const [mergeMessage, setMergeMessage] = useState('');
  const [mergeSaving, setMergeSaving] = useState(false);
  const [mergeModalError, setMergeModalError] = useState<string | null>(null);

  const [editing, setEditing] = useState<DebtRow | null>(null);
  const [editName, setEditName] = useState('');
  const [editAmount, setEditAmount] = useState('');
  const [editMessage, setEditMessage] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  type DebtFilter = 'ALL' | DebtStatus;
  const [filter, setFilter] = useState<DebtFilter>('ALL');

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('debts')
      .select(
        'id, owed_by_name, amount, status, share_token, transaction_id, target_account_id, message, created_at, merged_from'
      )
      // A debt folded into another one via merge (supabase/migrations/
      // 0011_debts_merge_supersede.sql) is history, not something to act
      // on — it stays in the table (so its old share link can point
      // visitors to the replacement) but has no place in this list.
      .neq('status', 'MERGED')
      .order('created_at', { ascending: false });
    setDebts(data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!user) return;
    supabase
      .from('profile')
      .select('month_start_day')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => setMonthStartDay(data?.month_start_day ?? 1));
  }, [user]);

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

  // "Show this directly to somebody" — opens the debtor's public page in a
  // new tab (web) rather than making Pavel copy a link and paste it
  // somewhere first. On native there's no tab concept, so it just opens the
  // link in the system browser instead.
  function openInNewTab(debt: DebtRow) {
    const link = shareLink(debt.share_token);
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.open(link, '_blank', 'noopener,noreferrer');
    } else {
      Linking.openURL(link);
    }
  }

  async function confirmSettled(debt: DebtRow) {
    if (!user) return;
    setBusyId(debt.id);

    // A merged debt has no single originating transaction (it may combine
    // several, possibly from different categories) — skip the lookup
    // rather than querying transactions.id = null, which would never
    // match anything anyway; the credit just lands uncategorized below.
    const { data: original } = debt.transaction_id
      ? await supabase.from('transactions').select('category_id, account_id').eq('id', debt.transaction_id).maybeSingle()
      : { data: null };

    const today = new Date().toISOString().slice(0, 10);
    const { data: credit, error: creditError } = await supabase
      .from('transactions')
      .insert({
        owner_id: user.id,
        budget_month: budgetMonthForDate(today, monthStartDay),
        transaction_date: today,
        type: 'DEBT_SETTLEMENT_CREDIT',
        category_id: original?.category_id ?? null,
        account_id: original?.account_id ?? debt.target_account_id,
        amount: debt.amount,
        note: `${t('debts.settledNotePrefix')}: ${debt.owed_by_name}`,
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
    setMergeError(null);
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setBulkConfirm(false);
    setMergeError(null);
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

  // Deliberately allows selecting debts with different (even misspelled)
  // owed_by_name values to merge — that's the actual point ("Maty" /
  // "maty" / "Matty" fragmenting one person across several debts). The
  // name field below defaults to the most recently created selection but
  // is editable, since only Pavel knows which spelling — or a different
  // one entirely — is the one to keep going forward.
  function openMergeModal() {
    const selected = debts.filter((d) => selectedIds.has(d.id));
    setMergeError(null);
    if (selected.length < 2) {
      setMergeError(t('debts.mergeNeedTwo'));
      return;
    }
    if (selected.some((d) => d.status !== 'OUTSTANDING')) {
      setMergeError(t('debts.mergeOnlyOutstanding'));
      return;
    }
    const totalAmount = selected.reduce((sum, d) => sum + Number(d.amount), 0);
    setMergeName(selected[0].owed_by_name);
    setMergeAmount(String(totalAmount));
    setMergeMessage(
      mergeDebtMessages(
        selected.map((d) => ({ message: d.message, amount: Number(d.amount) })),
        t('common.czk')
      )
    );
    setMergeModalError(null);
    setMergeModalOpen(true);
  }

  function closeMergeModal() {
    setMergeModalOpen(false);
    setMergeSaving(false);
    setMergeModalError(null);
  }

  async function confirmMerge() {
    if (!user) return;
    const selected = debts.filter((d) => selectedIds.has(d.id));
    const numericAmount = Number(mergeAmount);
    if (!numericAmount || numericAmount <= 0) {
      setMergeModalError(t('debts.amountError'));
      return;
    }
    if (!mergeName.trim()) {
      setMergeModalError(t('debts.nameError'));
      return;
    }
    setMergeSaving(true);
    setMergeModalError(null);

    // No transaction_id — a merged debt may combine debts from different
    // original transactions/categories, so it deliberately points at none
    // of them rather than misattributing the total (see migration 0009 and
    // confirmSettled's null-guard above).
    const { data: inserted, error: insertError } = await supabase
      .from('debts')
      .insert({
        owner_id: user.id,
        transaction_id: null,
        owed_by_name: mergeName.trim(),
        amount: numericAmount,
        target_account_id: selected[0]?.target_account_id,
        message: mergeMessage.trim() || null,
        // Snapshot of exactly what's being folded in, so "Unmerge" can
        // recreate every original row — see supabase/migrations/
        // 0010_debts_unmerge_support.sql.
        merged_from: buildMergedFromSnapshot(
          selected.map((d) => ({
            owed_by_name: d.owed_by_name,
            amount: Number(d.amount),
            message: d.message,
            transaction_id: d.transaction_id,
            target_account_id: d.target_account_id,
            merged_from: d.merged_from,
          }))
        ),
      })
      .select('share_token')
      .single();

    if (insertError || !inserted) {
      setMergeModalError(insertError?.message ?? t('debts.mergeGenericError'));
      setMergeSaving(false);
      return;
    }

    // Mark the folded-in debts MERGED and point them at the replacement,
    // instead of deleting them (supabase/migrations/
    // 0011_debts_merge_supersede.sql) — their public share links keep
    // resolving, now to a "this was merged" notice with a link to this
    // new one, rather than dead-ending.
    await supabase
      .from('debts')
      .update({ status: 'MERGED', merged_into_token: inserted.share_token })
      .in('id', selected.map((d) => d.id));

    setMergeSaving(false);
    setMergeModalOpen(false);
    setSelectMode(false);
    setSelectedIds(new Set());
    load();
  }

  // Undoes a merge (either the manual one above, or the "merge with
  // existing debt" offer at save time in ExpenseEntryForm/transactions).
  // Since 0011_debts_merge_supersede.sql, the folded-in debts are still
  // physically there (marked MERGED, not deleted) — so unmerging is just
  // reviving them: flip them back to OUTSTANDING and clear
  // merged_into_token, then delete the merged row. This restores each
  // one's ORIGINAL share_token too, so a link sent before the merge
  // starts working again instead of getting a new one — better than the
  // old delete-and-recreate-from-snapshot approach, which could only ever
  // hand out fresh links. `merged_from` is still what drives the button
  // (which debts to look for) and, being untouched here, still carries
  // forward correctly if one of the restored debts was itself already a
  // merge. Restricted to OUTSTANDING merged debts, same as merging
  // itself, since once claimed/settled the ledger already reflects the
  // combined total and unmerging would just be confusing. Two-tap
  // confirm, same pattern as handleDeleteOne below.
  async function handleUnmerge(debt: DebtRow) {
    if (!debt.merged_from || debt.merged_from.length === 0 || !user) return;
    if (pendingUnmergeId !== debt.id) {
      setPendingUnmergeId(debt.id);
      setTimeout(() => setPendingUnmergeId((cur) => (cur === debt.id ? null : cur)), 3000);
      return;
    }
    setPendingUnmergeId(null);
    setBusyId(debt.id);

    const { error: restoreError } = await supabase
      .from('debts')
      .update({ status: 'OUTSTANDING', merged_into_token: null })
      .eq('merged_into_token', debt.share_token);
    if (!restoreError) {
      await supabase.from('debts').delete().eq('id', debt.id);
    }
    setBusyId(null);
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
      setEditError(t('debts.amountError'));
      return;
    }
    if (!editName.trim()) {
      setEditError(t('debts.nameError'));
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

  const summary = useMemo(() => {
    const total = outstanding.reduce((sum, d) => sum + Number(d.amount), 0);
    const people = new Set(outstanding.map((d) => d.owed_by_name)).size;
    return { total, people };
  }, [outstanding]);

  const filters: { key: DebtFilter; label: string }[] = [
    { key: 'ALL', label: t('debts.filterAll') },
    { key: 'OUTSTANDING', label: t('debts.outstanding') },
    { key: 'CLAIMED_PAID', label: t('debts.awaitingConfirmation') },
    { key: 'SETTLED', label: t('debts.settled') },
  ];

  function DebtCard({ debt, action }: { debt: DebtRow; action?: 'settle' }) {
    const selected = selectedIds.has(debt.id);
    // Design refresh (2026-09): a per-person tint derived from their name
    // (see lib/identity.ts) so different debtors are distinguishable at a
    // glance instead of every row looking identical until you read the
    // name — there was no avatar/initial at all here before.
    const identity = identityColorFor(debt.owed_by_name, tokens);
    return (
      <Pressable
        key={debt.id}
        onPress={() => (selectMode ? toggleSelected(debt.id) : undefined)}
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

          <View style={[styles.avatar, { backgroundColor: withAlpha(identity, 0.16) }]}>
            <Text style={{ color: identity, fontFamily: fontFamily.extrabold, fontSize: 14 }}>
              {debt.owed_by_name.charAt(0).toUpperCase()}
            </Text>
          </View>

          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 15 }}>{debt.owed_by_name}</Text>
            <Text
              style={{
                color: tokens.textMuted,
                fontFamily: fontFamily.medium,
                fontSize: 12.5,
                marginTop: 2,
                fontVariant: ['tabular-nums'],
              }}
            >
              {debt.amount} CZK
            </Text>
          </View>

          {/* Status badge — Debts.dc.html gives every row one, but the real
              card only ever implied status through which action buttons
              showed up below (Pavel: "the same goes for... debts, redo it").
              Same three labels transactions.tsx's list already uses. */}
          {!selectMode && (
            <View
              style={[
                styles.statusBadge,
                {
                  backgroundColor:
                    debt.status === 'SETTLED' ? tokens.greenBg : debt.status === 'CLAIMED_PAID' ? tokens.amberBg : tokens.cardAlt,
                },
              ]}
            >
              <Text
                style={{
                  color: debt.status === 'SETTLED' ? tokens.greenFg : debt.status === 'CLAIMED_PAID' ? tokens.amberFg : tokens.textMuted,
                  fontFamily: fontFamily.bold,
                  fontSize: 11,
                }}
              >
                {debt.status === 'SETTLED'
                  ? t('debts.settled')
                  : debt.status === 'CLAIMED_PAID'
                  ? t('debts.awaitingConfirmation')
                  : t('debts.outstanding')}
              </Text>
            </View>
          )}
        </View>

        {!selectMode && (
          <View style={styles.cardActions}>
            {debt.status !== 'SETTLED' && (
              <>
                <Pressable onPress={() => copyLink(debt)} style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}>
                  <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12 }}>
                    {copiedId === debt.id ? t('common.copied') : t('common.copyLink')}
                  </Text>
                </Pressable>
                <Pressable onPress={() => openInNewTab(debt)} style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}>
                  <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12 }}>
                    {t('debts.openLink')}
                  </Text>
                </Pressable>
              </>
            )}
            {action === 'settle' && (
              <Pressable
                onPress={() => confirmSettled(debt)}
                disabled={busyId === debt.id}
                style={[
                  styles.smallBtn,
                  { backgroundColor: tokens.accent, opacity: busyId === debt.id ? 0.6 : 1, shadowColor: tokens.accent },
                  styles.smallBtnPrimary,
                ]}
              >
                <Text style={{ color: tokens.accentText, fontFamily: fontFamily.semibold, fontSize: 12 }}>
                  {t('debts.confirmSettled')}
                </Text>
              </Pressable>
            )}
            {debt.merged_from && debt.merged_from.length > 0 && debt.status === 'OUTSTANDING' && (
              <Pressable
                onPress={() => handleUnmerge(debt)}
                style={[styles.smallBtn, { backgroundColor: pendingUnmergeId === debt.id ? tokens.coral : tokens.cardAlt }]}
              >
                <Text
                  style={{
                    color: pendingUnmergeId === debt.id ? tokens.accentText : tokens.text,
                    fontFamily: fontFamily.semibold,
                    fontSize: 12,
                  }}
                >
                  {pendingUnmergeId === debt.id ? t('common.confirmQuestion') : t('debts.unmergeBtn')}
                </Text>
              </Pressable>
            )}
            <Pressable onPress={() => openEdit(debt)} style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}>
              <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12 }}>{t('common.edit')}</Text>
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
                {pendingDeleteId === debt.id ? t('common.confirmQuestion') : t('common.delete')}
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
          {selectMode && selectedIds.size > 0 ? `${selectedIds.size} ${t('transactions.selected')}` : ' '}
        </Text>
        <Pressable onPress={toggleSelectMode}>
          <Text style={{ color: tokens.accent, fontFamily: fontFamily.semibold, fontSize: 13 }}>
            {selectMode ? t('common.cancel') : t('common.select')}
          </Text>
        </Pressable>
      </View>

      {!loading && (
        <>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13, marginBottom: 12 }}>
            {summary.total > 0
              ? `${summary.total} ${t('common.czk')} ${t('debts.outstanding').toLowerCase()} · ${summary.people} ${t('debts.people')}`
              : t('debts.nobodyOwes')}
          </Text>
          <View style={[styles.filterRow]}>
            {filters.map((f) => {
              const active = filter === f.key;
              return (
                <Pressable
                  key={f.key}
                  onPress={() => setFilter(f.key)}
                  style={[styles.filterChip, { backgroundColor: active ? tokens.accent : tokens.card }]}
                >
                  <Text
                    style={{
                      color: active ? tokens.accentText : tokens.text,
                      fontFamily: fontFamily.semibold,
                      fontSize: 12.5,
                    }}
                  >
                    {f.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </>
      )}

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: selectMode ? 90 : 40 }}>
        {loading ? (
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium }}>{t('common.loading')}</Text>
        ) : (
          <>
            {(filter === 'ALL' || filter === 'CLAIMED_PAID') && (
              <Section
                title={t('debts.awaitingConfirmation')}
                items={awaitingConfirmation}
                action="settle"
                emptyNote={t('debts.nothingMarkedPaid')}
              />
            )}
            {(filter === 'ALL' || filter === 'OUTSTANDING') && (
              <Section title={t('debts.outstanding')} items={outstanding} emptyNote={t('debts.nobodyOwes')} />
            )}
            {(filter === 'ALL' || filter === 'SETTLED') && (
              <Section title={t('debts.settled')} items={settled} emptyNote={t('debts.noSettledYet')} />
            )}
          </>
        )}
      </ScrollView>

      {selectMode && (
        <View style={[styles.bulkBar, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
          <Text
            style={{
              color: mergeError ? tokens.coral : tokens.textMuted,
              fontFamily: fontFamily.medium,
              fontSize: 12.5,
              flexShrink: 1,
            }}
          >
            {mergeError
              ? mergeError
              : selectedIds.size === 0
              ? t('debts.tapToSelect')
              : `${selectedIds.size} ${t('transactions.selected')}`}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable
              onPress={openMergeModal}
              disabled={selectedIds.size < 2}
              style={[styles.bulkDeleteBtn, { backgroundColor: tokens.cardAlt, opacity: selectedIds.size < 2 ? 0.5 : 1 }]}
            >
              <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 13 }}>
                {t('debts.mergeBtn')}
              </Text>
            </Pressable>
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
                  ? `${t('transactions.confirmDelete')} (${selectedIds.size})?`
                  : `${t('common.delete')}${selectedIds.size ? ` (${selectedIds.size})` : ''}`}
              </Text>
            </Pressable>
          </View>
        </View>
      )}

      <Modal visible={editing !== null} transparent animationType="fade" onRequestClose={closeEdit}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.border }]}>
            <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 16, marginBottom: 14 }}>
              {t('debts.editTitle')}
            </Text>

            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginBottom: 6 }}>
              {t('debts.whoOwesLabel')}
            </Text>
            <TextInput
              value={editName}
              onChangeText={setEditName}
              style={[styles.modalInput, { color: tokens.text, borderColor: tokens.border }]}
            />

            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginTop: 12, marginBottom: 6 }}>
              {t('debts.amountLabel')}
            </Text>
            <TextInput
              value={editAmount}
              onChangeText={setEditAmount}
              keyboardType="numeric"
              style={[styles.modalInput, { color: tokens.text, borderColor: tokens.border }]}
            />

            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginTop: 12, marginBottom: 6 }}>
              {t('debts.messageLabel')}
            </Text>
            <TextInput
              value={editMessage}
              onChangeText={setEditMessage}
              placeholder={t('common.optional')}
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
                <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>{t('common.cancel')}</Text>
              </Pressable>
              <Pressable
                onPress={saveEdit}
                disabled={editSaving}
                style={[styles.modalBtn, { backgroundColor: tokens.accent, opacity: editSaving ? 0.6 : 1 }]}
              >
                <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 14 }}>
                  {editSaving ? t('common.saving') : t('common.save')}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={mergeModalOpen} transparent animationType="fade" onRequestClose={closeMergeModal}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.border }]}>
          <ScrollView>
            <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 16, marginBottom: 10 }}>
              {t('debts.mergeTitle')}
            </Text>

            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginBottom: 10 }}>
              {t('debts.mergeIntro')}
            </Text>

            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.semibold, fontSize: 11.5, marginBottom: 4 }}>
              {t('debts.mergeCombining')}
            </Text>
            {debts
              .filter((d) => selectedIds.has(d.id))
              .map((d) => (
                <Text key={d.id} style={{ color: tokens.text, fontFamily: fontFamily.medium, fontSize: 12.5, marginBottom: 2 }}>
                  {d.owed_by_name} — {d.amount} {t('common.czk')}
                </Text>
              ))}

            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginTop: 14, marginBottom: 6 }}>
              {t('debts.whoOwesLabel')}
            </Text>
            <TextInput
              value={mergeName}
              onChangeText={setMergeName}
              style={[styles.modalInput, { color: tokens.text, borderColor: tokens.border }]}
            />

            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginTop: 12, marginBottom: 6 }}>
              {t('debts.amountLabel')}
            </Text>
            <TextInput
              value={mergeAmount}
              onChangeText={setMergeAmount}
              keyboardType="numeric"
              style={[styles.modalInput, { color: tokens.text, borderColor: tokens.border }]}
            />

            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginTop: 12, marginBottom: 6 }}>
              {t('debts.messageLabel')}
            </Text>
            <TextInput
              value={mergeMessage}
              onChangeText={setMergeMessage}
              placeholder={t('common.optional')}
              placeholderTextColor={tokens.textMuted}
              style={[styles.modalInput, { color: tokens.text, borderColor: tokens.border }]}
            />

            {mergeModalError && (
              <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 12.5, marginTop: 12 }}>
                {mergeModalError}
              </Text>
            )}

            <View style={styles.modalActions}>
              <Pressable onPress={closeMergeModal} style={[styles.modalBtn, { backgroundColor: tokens.card }]}>
                <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>{t('common.cancel')}</Text>
              </Pressable>
              <Pressable
                onPress={confirmMerge}
                disabled={mergeSaving}
                style={[styles.modalBtn, { backgroundColor: tokens.accent, opacity: mergeSaving ? 0.6 : 1 }]}
              >
                <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 14 }}>
                  {mergeSaving ? t('debts.merging') : t('debts.mergeConfirm')}
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
  section: { marginBottom: 28 },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 18 },
  filterChip: { paddingHorizontal: 13, paddingVertical: 8, borderRadius: 12 },
  // A card used to be one row (name+amount, then action buttons trailing
  // to the right) — with `justifyContent: 'space-between'` and no wrap,
  // the buttons row never actually shrank (React Native's default
  // flexShrink is 0, unlike web CSS), so a longer label set — Czech's
  // "Kopírovat odkaz" / "Potvrdit vyrovnání" run noticeably longer than
  // English — could claim more width than the card had, squeezing the
  // name down to nothing. Stacking the actions onto their own row below
  // (still wrapping if it ever needs to) sidesteps that regardless of
  // language or button count, rather than patching widths per language.
  card: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 14,
    marginBottom: 8,
    gap: 10,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 9, flexShrink: 0, alignSelf: 'flex-start' },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardActions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  smallBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 11 },
  smallBtnPrimary: { shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 5 }, elevation: 3 },
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
  bulkDeleteBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12 },
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
    maxHeight: '85%',
    borderRadius: 20,
    borderWidth: 1,
    padding: 20,
  },
  modalInput: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 20 },
  modalBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
});
