import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'expo-router';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { useAuth } from '@/lib/auth-context';
import { useLanguage } from '@/lib/language-context';
import { supabase } from '@/lib/supabase';
import { computeDueRecurringItems, confirmRecurringItem, type ConfirmedRecurringTx } from '@/lib/recurring';
import { accrualProgress, currentCycle, isFinalPaymentDue, isReserveTransferDue, type LongTermTx } from '@/lib/long-term';
import type {
  Account,
  Category,
  LongTermItem,
  RecurringFrequency,
  RecurringItem,
  ReserveAmountMode,
} from '@/types/database';

/**
 * Planning — "the stuff I check and act on regularly," split out of More
 * (now Settings) at Pavel's request: Recurring items (moved here unchanged
 * from Settings) and Long-term & reserve items (new, Phase 3), grouped
 * together because both are forward-looking, recurring financial-planning
 * concerns — unlike Settings, which is one-time configuration.
 *
 * Long-term items are shown here read-only (the list, accrual progress
 * bars, and CRUD) — actually generating a QR payment or confirming a
 * reserve transfer / final payment happens in the guided monthly wizard
 * (app/wizard.tsx), matching screens-and-flows.md's wizard step 4. That
 * split keeps this tab a quick glance-and-manage screen and the wizard the
 * one guided place where money actually moves for long-term bills.
 * Recurring items don't need that ceremony (no QR, no reserve math), so
 * their "due, tap to confirm" banner stays directly on this tab.
 */
export default function Planning() {
  const { tokens } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();

  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);

  // ── Recurring items ──────────────────────────────────────────────────
  const [recurringItems, setRecurringItems] = useState<RecurringItem[]>([]);
  const [recurringConfirmedTx, setRecurringConfirmedTx] = useState<ConfirmedRecurringTx[]>([]);
  const [showArchivedRecurring, setShowArchivedRecurring] = useState(false);

  const [newRecurringName, setNewRecurringName] = useState('');
  const [newRecurringAmount, setNewRecurringAmount] = useState('');
  const [newRecurringCategoryId, setNewRecurringCategoryId] = useState<string | null>(null);
  const [newRecurringAccountId, setNewRecurringAccountId] = useState<string | null>(null);
  const [newRecurringFrequency, setNewRecurringFrequency] = useState<RecurringFrequency>('MONTHLY');
  const [newRecurringDay, setNewRecurringDay] = useState('1');
  const [addingRecurring, setAddingRecurring] = useState(false);

  const [editingRecurring, setEditingRecurring] = useState<RecurringItem | null>(null);
  const [editRecurringName, setEditRecurringName] = useState('');
  const [editRecurringAmount, setEditRecurringAmount] = useState('');
  const [editRecurringCategoryId, setEditRecurringCategoryId] = useState<string | null>(null);
  const [editRecurringAccountId, setEditRecurringAccountId] = useState<string | null>(null);
  const [editRecurringFrequency, setEditRecurringFrequency] = useState<RecurringFrequency>('MONTHLY');
  const [editRecurringDay, setEditRecurringDay] = useState('1');
  const [editRecurringSaving, setEditRecurringSaving] = useState(false);
  const [editRecurringError, setEditRecurringError] = useState<string | null>(null);

  const [dueAmountOverrides, setDueAmountOverrides] = useState<Record<string, string>>({});
  const [confirmingDueId, setConfirmingDueId] = useState<string | null>(null);

  // ── Long-term & reserve items ────────────────────────────────────────
  const [longTermItems, setLongTermItems] = useState<LongTermItem[]>([]);
  const [longTermTx, setLongTermTx] = useState<LongTermTx[]>([]);
  const [showArchivedLongTerm, setShowArchivedLongTerm] = useState(false);
  const [showLongTermForm, setShowLongTermForm] = useState(false);

  const [ltName, setLtName] = useState('');
  const [ltCategoryId, setLtCategoryId] = useState<string | null>(null);
  const [ltFullAmount, setLtFullAmount] = useState('');
  const [ltPaymentMonth, setLtPaymentMonth] = useState('');
  const [ltFirstReserveMonth, setLtFirstReserveMonth] = useState('');
  const [ltMode, setLtMode] = useState<ReserveAmountMode>('AUTO');
  const [ltManualReserve, setLtManualReserve] = useState('');
  const [ltOpeningBalance, setLtOpeningBalance] = useState('0');
  const [ltRepeatYearly, setLtRepeatYearly] = useState(true);
  const [ltReserveAccountId, setLtReserveAccountId] = useState<string | null>(null);
  const [ltTargetPrefix, setLtTargetPrefix] = useState('');
  const [ltTargetNumber, setLtTargetNumber] = useState('');
  const [ltTargetBankCode, setLtTargetBankCode] = useState('');
  const [ltVariableSymbol, setLtVariableSymbol] = useState('');
  const [ltPaymentMessage, setLtPaymentMessage] = useState('');
  const [addingLongTerm, setAddingLongTerm] = useState(false);
  const [longTermFormError, setLongTermFormError] = useState<string | null>(null);

  const [editingLongTerm, setEditingLongTerm] = useState<LongTermItem | null>(null);
  const [editingLongTermSaving, setEditingLongTermSaving] = useState(false);
  const [editingLongTermError, setEditingLongTermError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const yearStart = `${new Date().getFullYear()}-01-01`;
    const [categoriesRes, accountsRes, recurringRes, recurringTxRes, longTermRes, longTermTxRes] = await Promise.all([
      supabase.from('categories').select('*').eq('owner_id', user.id).order('sort_order'),
      supabase.from('accounts').select('*').eq('owner_id', user.id).order('sort_order'),
      supabase.from('recurring_items').select('*').eq('owner_id', user.id).order('name'),
      supabase
        .from('transactions')
        .select('recurring_item_id, transaction_date')
        .eq('owner_id', user.id)
        .not('recurring_item_id', 'is', null)
        .gte('transaction_date', yearStart),
      supabase.from('long_term_items').select('*').eq('owner_id', user.id).order('name'),
      // No date filter here (unlike recurring's yearStart above) — a
      // repeat_yearly item's reserve window can span back nearly a year
      // and cross a calendar-year boundary, so windowing this by "this
      // year" would undercount reservedSoFar right after New Year's.
      supabase
        .from('transactions')
        .select('long_term_item_id, type, amount, transaction_date')
        .eq('owner_id', user.id)
        .not('long_term_item_id', 'is', null),
    ]);
    setCategories(categoriesRes.data ?? []);
    setAccounts(accountsRes.data ?? []);
    setRecurringItems(recurringRes.data ?? []);
    setRecurringConfirmedTx((recurringTxRes.data ?? []) as ConfirmedRecurringTx[]);
    setLongTermItems(longTermRes.data ?? []);
    setLongTermTx((longTermTxRes.data ?? []) as LongTermTx[]);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  // ── Recurring actions (unchanged from the old More screen) ──────────
  async function addRecurringItem() {
    if (!user || !newRecurringName.trim() || !newRecurringCategoryId || !newRecurringAccountId) return;
    const amount = Number(newRecurringAmount);
    if (!amount || amount <= 0) return;
    const day = Math.min(28, Math.max(1, Math.round(Number(newRecurringDay)) || 1));
    setAddingRecurring(true);
    await supabase.from('recurring_items').insert({
      owner_id: user.id,
      name: newRecurringName.trim(),
      category_id: newRecurringCategoryId,
      account_id: newRecurringAccountId,
      amount,
      frequency: newRecurringFrequency,
      day_of_month: day,
    });
    setNewRecurringName('');
    setNewRecurringAmount('');
    setNewRecurringCategoryId(null);
    setNewRecurringAccountId(null);
    setNewRecurringFrequency('MONTHLY');
    setNewRecurringDay('1');
    setAddingRecurring(false);
    load();
  }

  async function toggleRecurringActive(item: RecurringItem) {
    await supabase.from('recurring_items').update({ active: !item.active }).eq('id', item.id);
    load();
  }

  function openEditRecurring(item: RecurringItem) {
    setEditingRecurring(item);
    setEditRecurringName(item.name);
    setEditRecurringAmount(String(item.amount));
    setEditRecurringCategoryId(item.category_id);
    setEditRecurringAccountId(item.account_id);
    setEditRecurringFrequency(item.frequency);
    setEditRecurringDay(String(item.day_of_month));
    setEditRecurringError(null);
  }

  function closeEditRecurring() {
    setEditingRecurring(null);
    setEditRecurringSaving(false);
    setEditRecurringError(null);
  }

  async function saveEditRecurring() {
    if (!editingRecurring) return;
    const amount = Number(editRecurringAmount);
    if (!amount || amount <= 0) {
      setEditRecurringError(t('more.recurringAmountError'));
      return;
    }
    if (!editRecurringName.trim() || !editRecurringCategoryId || !editRecurringAccountId) {
      setEditRecurringError(t('more.recurringFieldsError'));
      return;
    }
    const day = Math.min(28, Math.max(1, Math.round(Number(editRecurringDay)) || 1));
    setEditRecurringSaving(true);
    const { error } = await supabase
      .from('recurring_items')
      .update({
        name: editRecurringName.trim(),
        amount,
        category_id: editRecurringCategoryId,
        account_id: editRecurringAccountId,
        frequency: editRecurringFrequency,
        day_of_month: day,
      })
      .eq('id', editingRecurring.id);

    if (error) {
      setEditRecurringError(error.message);
      setEditRecurringSaving(false);
      return;
    }
    closeEditRecurring();
    load();
  }

  async function confirmDue(item: RecurringItem) {
    if (!user) return;
    setConfirmingDueId(item.id);
    const overrideStr = dueAmountOverrides[item.id];
    const overrideAmount = overrideStr ? Number(overrideStr) : undefined;
    const { error } = await confirmRecurringItem(
      user.id,
      item,
      overrideAmount && overrideAmount > 0 ? overrideAmount : undefined
    );
    setConfirmingDueId(null);
    if (!error) {
      setDueAmountOverrides((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      load();
    }
  }

  // ── Long-term actions ─────────────────────────────────────────────────
  function resetLongTermForm() {
    setLtName('');
    setLtCategoryId(null);
    setLtFullAmount('');
    setLtPaymentMonth('');
    setLtFirstReserveMonth('');
    setLtMode('AUTO');
    setLtManualReserve('');
    setLtOpeningBalance('0');
    setLtRepeatYearly(true);
    setLtReserveAccountId(null);
    setLtTargetPrefix('');
    setLtTargetNumber('');
    setLtTargetBankCode('');
    setLtVariableSymbol('');
    setLtPaymentMessage('');
    setLongTermFormError(null);
  }

  function validMonthInput(v: string): boolean {
    return /^\d{4}-\d{2}$/.test(v.trim());
  }

  async function addLongTermItem() {
    if (!user) return;
    if (!ltName.trim() || !ltCategoryId) {
      setLongTermFormError(t('more.longTermFieldsError'));
      return;
    }
    const fullAmount = Number(ltFullAmount);
    if (!fullAmount || fullAmount <= 0) {
      setLongTermFormError(t('more.longTermAmountError'));
      return;
    }
    if (!validMonthInput(ltPaymentMonth) || !validMonthInput(ltFirstReserveMonth)) {
      setLongTermFormError(t('more.longTermMonthError'));
      return;
    }
    setAddingLongTerm(true);
    setLongTermFormError(null);
    const { error } = await supabase.from('long_term_items').insert({
      owner_id: user.id,
      name: ltName.trim(),
      category_id: ltCategoryId,
      full_payment_amount: fullAmount,
      payment_month: `${ltPaymentMonth.trim()}-01`,
      first_reserve_month: `${ltFirstReserveMonth.trim()}-01`,
      reserve_amount_mode: ltMode,
      manual_monthly_reserve: ltMode === 'MANUAL' ? Number(ltManualReserve) || 0 : null,
      opening_reserve_balance: Number(ltOpeningBalance) || 0,
      repeat_yearly: ltRepeatYearly,
      reserve_account_id: ltReserveAccountId,
      target_account_prefix: ltTargetPrefix.trim() || null,
      target_account_number: ltTargetNumber.trim() || null,
      target_bank_code: ltTargetBankCode.trim() || null,
      variable_symbol: ltVariableSymbol.trim() || null,
      payment_message: ltPaymentMessage.trim() || null,
    });
    setAddingLongTerm(false);
    if (error) {
      setLongTermFormError(error.message);
      return;
    }
    resetLongTermForm();
    setShowLongTermForm(false);
    load();
  }

  async function toggleLongTermActive(item: LongTermItem) {
    await supabase.from('long_term_items').update({ active: !item.active }).eq('id', item.id);
    load();
  }

  function openEditLongTerm(item: LongTermItem) {
    setEditingLongTerm(item);
    setLtName(item.name);
    setLtCategoryId(item.category_id);
    setLtFullAmount(String(item.full_payment_amount));
    setLtPaymentMonth(item.payment_month.slice(0, 7));
    setLtFirstReserveMonth(item.first_reserve_month.slice(0, 7));
    setLtMode(item.reserve_amount_mode);
    setLtManualReserve(item.manual_monthly_reserve ? String(item.manual_monthly_reserve) : '');
    setLtOpeningBalance(String(item.opening_reserve_balance));
    setLtRepeatYearly(item.repeat_yearly);
    setLtReserveAccountId(item.reserve_account_id);
    setLtTargetPrefix(item.target_account_prefix ?? '');
    setLtTargetNumber(item.target_account_number ?? '');
    setLtTargetBankCode(item.target_bank_code ?? '');
    setLtVariableSymbol(item.variable_symbol ?? '');
    setLtPaymentMessage(item.payment_message ?? '');
    setEditingLongTermError(null);
  }

  function closeEditLongTerm() {
    setEditingLongTerm(null);
    resetLongTermForm();
    setEditingLongTermSaving(false);
    setEditingLongTermError(null);
  }

  async function saveEditLongTerm() {
    if (!editingLongTerm) return;
    if (!ltName.trim() || !ltCategoryId) {
      setEditingLongTermError(t('more.longTermFieldsError'));
      return;
    }
    const fullAmount = Number(ltFullAmount);
    if (!fullAmount || fullAmount <= 0) {
      setEditingLongTermError(t('more.longTermAmountError'));
      return;
    }
    if (!validMonthInput(ltPaymentMonth) || !validMonthInput(ltFirstReserveMonth)) {
      setEditingLongTermError(t('more.longTermMonthError'));
      return;
    }
    setEditingLongTermSaving(true);
    const { error } = await supabase
      .from('long_term_items')
      .update({
        name: ltName.trim(),
        category_id: ltCategoryId,
        full_payment_amount: fullAmount,
        payment_month: `${ltPaymentMonth.trim()}-01`,
        first_reserve_month: `${ltFirstReserveMonth.trim()}-01`,
        reserve_amount_mode: ltMode,
        manual_monthly_reserve: ltMode === 'MANUAL' ? Number(ltManualReserve) || 0 : null,
        opening_reserve_balance: Number(ltOpeningBalance) || 0,
        repeat_yearly: ltRepeatYearly,
        reserve_account_id: ltReserveAccountId,
        target_account_prefix: ltTargetPrefix.trim() || null,
        target_account_number: ltTargetNumber.trim() || null,
        target_bank_code: ltTargetBankCode.trim() || null,
        variable_symbol: ltVariableSymbol.trim() || null,
        payment_message: ltPaymentMessage.trim() || null,
      })
      .eq('id', editingLongTerm.id);

    setEditingLongTermSaving(false);
    if (error) {
      setEditingLongTermError(error.message);
      return;
    }
    closeEditLongTerm();
    load();
  }

  // ── Derived ────────────────────────────────────────────────────────
  const visibleRecurring = recurringItems.filter((r) => (showArchivedRecurring ? true : r.active));
  const visibleLongTerm = longTermItems.filter((l) => (showArchivedLongTerm ? true : l.active));
  const categoryNameById = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  const accountNameById = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);
  const dueRecurringItems = useMemo(
    () => computeDueRecurringItems(recurringItems, recurringConfirmedTx),
    [recurringItems, recurringConfirmedTx]
  );

  const longTermDueCount = useMemo(() => {
    let count = 0;
    for (const item of longTermItems) {
      if (!item.active) continue;
      const cycle = currentCycle(item);
      if (isReserveTransferDue(item, cycle, longTermTx) || isFinalPaymentDue(item, cycle, longTermTx)) count++;
    }
    return count;
  }, [longTermItems, longTermTx]);

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 60 }}>
      <View style={styles.headerRow}>
        <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 24 }}>{t('more.planningTitle')}</Text>
        <Link href="/wizard" asChild>
          <Pressable style={StyleSheet.flatten([styles.wizardBtn, { backgroundColor: tokens.accent }])}>
            <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 13 }}>
              {t('more.startMonthlyReview')}
              {longTermDueCount > 0 ? ` (${longTermDueCount})` : ''}
            </Text>
          </Pressable>
        </Link>
      </View>

      {loading ? (
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium }}>{t('common.loading')}</Text>
      ) : (
        <>
          {/* ── Recurring items ─────────────────────────────────────── */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 16 }}>
                {t('more.recurringItems')}
              </Text>
              <Pressable onPress={() => setShowArchivedRecurring((v) => !v)}>
                <Text style={{ color: tokens.accent, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                  {showArchivedRecurring ? t('more.active') : t('more.archived')}
                </Text>
              </Pressable>
            </View>

            {dueRecurringItems.length > 0 && (
              <View style={[styles.dueBanner, { backgroundColor: tokens.greenBg, borderColor: tokens.border }]}>
                <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.extrabold, fontSize: 13, marginBottom: 8 }}>
                  {t('more.dueToConfirm')} ({dueRecurringItems.length})
                </Text>
                {dueRecurringItems.map((item) => (
                  <View key={item.id} style={styles.dueRow}>
                    <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.semibold, fontSize: 13, flex: 1 }}>
                      {item.name}
                    </Text>
                    <TextInput
                      value={dueAmountOverrides[item.id] ?? String(item.amount)}
                      onChangeText={(v) => setDueAmountOverrides((prev) => ({ ...prev, [item.id]: v }))}
                      keyboardType="numeric"
                      style={[styles.dueAmountInput, { color: tokens.text, borderColor: tokens.border }]}
                    />
                    <Pressable
                      onPress={() => confirmDue(item)}
                      disabled={confirmingDueId === item.id}
                      style={[
                        styles.smallBtn,
                        { backgroundColor: tokens.accent, opacity: confirmingDueId === item.id ? 0.6 : 1 },
                      ]}
                    >
                      <Text style={{ color: tokens.accentText, fontFamily: fontFamily.semibold, fontSize: 12 }}>
                        {t('more.confirm')}
                      </Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            )}

            {visibleRecurring.length === 0 && (
              <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13, marginBottom: 10 }}>
                {t('more.noRecurring')}
              </Text>
            )}
            {visibleRecurring.map((item) => (
              <View
                key={item.id}
                style={[styles.row, { backgroundColor: tokens.card, borderColor: tokens.border, flexWrap: 'wrap' }]}
              >
                <View style={{ flex: 1, minWidth: 160 }}>
                  <Text
                    style={{
                      color: item.active ? tokens.text : tokens.textMuted,
                      fontFamily: fontFamily.semibold,
                      fontSize: 14,
                    }}
                  >
                    {item.name}
                  </Text>
                  <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 2 }}>
                    {item.amount} {t('common.czk')} · {categoryNameById.get(item.category_id) ?? '—'} ·{' '}
                    {accountNameById.get(item.account_id) ?? '—'} ·{' '}
                    {item.frequency === 'MONTHLY' ? t('more.frequencyMonthly') : t('more.frequencyYearly')} ·{' '}
                    {t('more.dayOfMonthShort')} {item.day_of_month}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  {item.active && (
                    <Pressable
                      onPress={() => openEditRecurring(item)}
                      style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}
                    >
                      <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12 }}>
                        {t('common.edit')}
                      </Text>
                    </Pressable>
                  )}
                  <Pressable
                    onPress={() => toggleRecurringActive(item)}
                    style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}
                  >
                    <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12 }}>
                      {item.active ? t('more.archive') : t('more.unarchive')}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ))}

            <View style={[styles.newAccountCard, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
              <TextInput
                value={newRecurringName}
                onChangeText={setNewRecurringName}
                placeholder={t('more.recurringNamePlaceholder')}
                placeholderTextColor={tokens.textMuted}
                style={[styles.addInput, { color: tokens.text, borderColor: tokens.border, marginBottom: 8 }]}
              />
              <TextInput
                value={newRecurringAmount}
                onChangeText={setNewRecurringAmount}
                keyboardType="numeric"
                placeholder={t('more.recurringAmountPlaceholder')}
                placeholderTextColor={tokens.textMuted}
                style={[styles.addInput, { color: tokens.text, borderColor: tokens.border, marginBottom: 10 }]}
              />

              <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginBottom: 6 }}>
                {t('transactions.categoryLabel')}
              </Text>
              <View style={styles.chipRow}>
                {categories
                  .filter((c) => c.active)
                  .map((cat) => (
                    <Pressable
                      key={cat.id}
                      onPress={() => setNewRecurringCategoryId(cat.id)}
                      style={[
                        styles.chip,
                        { backgroundColor: newRecurringCategoryId === cat.id ? tokens.accent : tokens.cardAlt },
                      ]}
                    >
                      <Text
                        style={{
                          color: newRecurringCategoryId === cat.id ? tokens.accentText : tokens.text,
                          fontFamily: fontFamily.semibold,
                          fontSize: 12,
                        }}
                      >
                        {cat.name}
                      </Text>
                    </Pressable>
                  ))}
              </View>

              <Text
                style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 10, marginBottom: 6 }}
              >
                {t('more.accounts')}
              </Text>
              <View style={styles.chipRow}>
                {accounts
                  .filter((a) => a.active)
                  .map((acc) => (
                    <Pressable
                      key={acc.id}
                      onPress={() => setNewRecurringAccountId(acc.id)}
                      style={[
                        styles.chip,
                        { backgroundColor: newRecurringAccountId === acc.id ? tokens.accent : tokens.cardAlt },
                      ]}
                    >
                      <Text
                        style={{
                          color: newRecurringAccountId === acc.id ? tokens.accentText : tokens.text,
                          fontFamily: fontFamily.semibold,
                          fontSize: 12,
                        }}
                      >
                        {acc.name}
                      </Text>
                    </Pressable>
                  ))}
              </View>

              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginBottom: 6 }}>
                    {t('more.frequency')}
                  </Text>
                  <View style={styles.chipRow}>
                    {(['MONTHLY', 'YEARLY'] as RecurringFrequency[]).map((freq) => (
                      <Pressable
                        key={freq}
                        onPress={() => setNewRecurringFrequency(freq)}
                        style={[
                          styles.chip,
                          { backgroundColor: newRecurringFrequency === freq ? tokens.accent : tokens.cardAlt },
                        ]}
                      >
                        <Text
                          style={{
                            color: newRecurringFrequency === freq ? tokens.accentText : tokens.text,
                            fontFamily: fontFamily.semibold,
                            fontSize: 12,
                          }}
                        >
                          {freq === 'MONTHLY' ? t('more.frequencyMonthly') : t('more.frequencyYearly')}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
                <View style={{ width: 90 }}>
                  <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginBottom: 6 }}>
                    {t('more.dayOfMonth')}
                  </Text>
                  <TextInput
                    value={newRecurringDay}
                    onChangeText={setNewRecurringDay}
                    keyboardType="numeric"
                    style={[styles.addInput, { color: tokens.text, borderColor: tokens.border }]}
                  />
                </View>
              </View>

              <Pressable
                onPress={addRecurringItem}
                disabled={
                  addingRecurring || !newRecurringName.trim() || !newRecurringCategoryId || !newRecurringAccountId || !newRecurringAmount
                }
                style={[
                  styles.addBtn,
                  {
                    backgroundColor: tokens.accent,
                    opacity:
                      newRecurringName.trim() && newRecurringCategoryId && newRecurringAccountId && newRecurringAmount
                        ? 1
                        : 0.5,
                    marginTop: 12,
                    alignSelf: 'flex-start',
                  },
                ]}
              >
                <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 13 }}>
                  {t('more.addRecurring')}
                </Text>
              </Pressable>
            </View>
          </View>

          {/* ── Long-term & reserve ─────────────────────────────────── */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 16 }}>
                {t('more.longTermItems')}
              </Text>
              <Pressable onPress={() => setShowArchivedLongTerm((v) => !v)}>
                <Text style={{ color: tokens.accent, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                  {showArchivedLongTerm ? t('more.active') : t('more.archived')}
                </Text>
              </Pressable>
            </View>

            {visibleLongTerm.length === 0 && (
              <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13, marginBottom: 10 }}>
                {t('more.noLongTerm')}
              </Text>
            )}
            {visibleLongTerm.map((item) => {
              const cycle = currentCycle(item);
              const { reserved, pct } = accrualProgress(item, cycle, longTermTx);
              const reserveDue = isReserveTransferDue(item, cycle, longTermTx);
              const paymentDue = isFinalPaymentDue(item, cycle, longTermTx);
              return (
                <View key={item.id} style={[styles.ltCard, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
                  <View style={styles.ltCardTop}>
                    <View style={{ flex: 1 }}>
                      <Text
                        style={{
                          color: item.active ? tokens.text : tokens.textMuted,
                          fontFamily: fontFamily.semibold,
                          fontSize: 14,
                        }}
                      >
                        {item.name}
                      </Text>
                      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 2 }}>
                        {categoryNameById.get(item.category_id) ?? '—'} · {t('more.longTermPaymentMonth')}{' '}
                        {cycle.paymentMonth.slice(0, 7)}
                        {item.repeat_yearly ? ` · ${t('more.longTermRepeatsYearly')}` : ''}
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      {item.active && (
                        <Pressable
                          onPress={() => openEditLongTerm(item)}
                          style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}
                        >
                          <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12 }}>
                            {t('common.edit')}
                          </Text>
                        </Pressable>
                      )}
                      <Pressable
                        onPress={() => toggleLongTermActive(item)}
                        style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}
                      >
                        <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12 }}>
                          {item.active ? t('more.archive') : t('more.unarchive')}
                        </Text>
                      </Pressable>
                    </View>
                  </View>

                  <View style={[styles.barTrack, { backgroundColor: tokens.cardAlt, marginTop: 10 }]}>
                    <View style={[styles.barFill, { width: `${Math.round(pct * 100)}%`, backgroundColor: tokens.accent }]} />
                  </View>
                  <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 4 }}>
                    {reserved} / {item.full_payment_amount} {t('common.czk')} {t('more.longTermReserved')}
                  </Text>

                  {(reserveDue || paymentDue) && (
                    <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.semibold, fontSize: 12, marginTop: 6 }}>
                      {paymentDue ? t('more.longTermPaymentDue') : t('more.longTermReserveDue')} ·{' '}
                      {t('more.longTermSeeWizard')}
                    </Text>
                  )}
                </View>
              );
            })}

            {!showLongTermForm ? (
              <Pressable
                onPress={() => {
                  resetLongTermForm();
                  setShowLongTermForm(true);
                }}
                style={[styles.addBtn, { backgroundColor: tokens.accent, marginTop: 4, alignSelf: 'flex-start' }]}
              >
                <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 13 }}>
                  {t('more.addLongTerm')}
                </Text>
              </Pressable>
            ) : (
              <LongTermForm
                mode="add"
                tokens={tokens}
                t={t}
                categories={categories}
                accounts={accounts}
                ltName={ltName}
                setLtName={setLtName}
                ltCategoryId={ltCategoryId}
                setLtCategoryId={setLtCategoryId}
                ltFullAmount={ltFullAmount}
                setLtFullAmount={setLtFullAmount}
                ltPaymentMonth={ltPaymentMonth}
                setLtPaymentMonth={setLtPaymentMonth}
                ltFirstReserveMonth={ltFirstReserveMonth}
                setLtFirstReserveMonth={setLtFirstReserveMonth}
                ltMode={ltMode}
                setLtMode={setLtMode}
                ltManualReserve={ltManualReserve}
                setLtManualReserve={setLtManualReserve}
                ltOpeningBalance={ltOpeningBalance}
                setLtOpeningBalance={setLtOpeningBalance}
                ltRepeatYearly={ltRepeatYearly}
                setLtRepeatYearly={setLtRepeatYearly}
                ltReserveAccountId={ltReserveAccountId}
                setLtReserveAccountId={setLtReserveAccountId}
                ltTargetPrefix={ltTargetPrefix}
                setLtTargetPrefix={setLtTargetPrefix}
                ltTargetNumber={ltTargetNumber}
                setLtTargetNumber={setLtTargetNumber}
                ltTargetBankCode={ltTargetBankCode}
                setLtTargetBankCode={setLtTargetBankCode}
                ltVariableSymbol={ltVariableSymbol}
                setLtVariableSymbol={setLtVariableSymbol}
                ltPaymentMessage={ltPaymentMessage}
                setLtPaymentMessage={setLtPaymentMessage}
                error={longTermFormError}
                onCancel={() => {
                  setShowLongTermForm(false);
                  resetLongTermForm();
                }}
                onSave={addLongTermItem}
                saving={addingLongTerm}
              />
            )}
          </View>
        </>
      )}

      <Modal visible={editingRecurring !== null} transparent animationType="fade" onRequestClose={closeEditRecurring}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.border }]}>
            <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 16, marginBottom: 14 }}>
              {t('more.editRecurringTitle')}
            </Text>

            <TextInput
              value={editRecurringName}
              onChangeText={setEditRecurringName}
              placeholder={t('more.recurringNamePlaceholder')}
              placeholderTextColor={tokens.textMuted}
              style={[styles.modalInput, { color: tokens.text, borderColor: tokens.border }]}
            />
            <TextInput
              value={editRecurringAmount}
              onChangeText={setEditRecurringAmount}
              keyboardType="numeric"
              placeholder={t('more.recurringAmountPlaceholder')}
              placeholderTextColor={tokens.textMuted}
              style={[styles.modalInput, { color: tokens.text, borderColor: tokens.border, marginTop: 10 }]}
            />

            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginTop: 12, marginBottom: 6 }}>
              {t('transactions.categoryLabel')}
            </Text>
            <View style={styles.chipRow}>
              {categories
                .filter((c) => c.active)
                .map((cat) => (
                  <Pressable
                    key={cat.id}
                    onPress={() => setEditRecurringCategoryId(cat.id)}
                    style={[
                      styles.chip,
                      { backgroundColor: editRecurringCategoryId === cat.id ? tokens.accent : tokens.cardAlt },
                    ]}
                  >
                    <Text
                      style={{
                        color: editRecurringCategoryId === cat.id ? tokens.accentText : tokens.text,
                        fontFamily: fontFamily.semibold,
                        fontSize: 12.5,
                      }}
                    >
                      {cat.name}
                    </Text>
                  </Pressable>
                ))}
            </View>

            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginTop: 12, marginBottom: 6 }}>
              {t('more.accounts')}
            </Text>
            <View style={styles.chipRow}>
              {accounts
                .filter((a) => a.active)
                .map((acc) => (
                  <Pressable
                    key={acc.id}
                    onPress={() => setEditRecurringAccountId(acc.id)}
                    style={[
                      styles.chip,
                      { backgroundColor: editRecurringAccountId === acc.id ? tokens.accent : tokens.cardAlt },
                    ]}
                  >
                    <Text
                      style={{
                        color: editRecurringAccountId === acc.id ? tokens.accentText : tokens.text,
                        fontFamily: fontFamily.semibold,
                        fontSize: 12.5,
                      }}
                    >
                      {acc.name}
                    </Text>
                  </Pressable>
                ))}
            </View>

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginBottom: 6 }}>
                  {t('more.frequency')}
                </Text>
                <View style={styles.chipRow}>
                  {(['MONTHLY', 'YEARLY'] as RecurringFrequency[]).map((freq) => (
                    <Pressable
                      key={freq}
                      onPress={() => setEditRecurringFrequency(freq)}
                      style={[
                        styles.chip,
                        { backgroundColor: editRecurringFrequency === freq ? tokens.accent : tokens.cardAlt },
                      ]}
                    >
                      <Text
                        style={{
                          color: editRecurringFrequency === freq ? tokens.accentText : tokens.text,
                          fontFamily: fontFamily.semibold,
                          fontSize: 12.5,
                        }}
                      >
                        {freq === 'MONTHLY' ? t('more.frequencyMonthly') : t('more.frequencyYearly')}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
              <View style={{ width: 90 }}>
                <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginBottom: 6 }}>
                  {t('more.dayOfMonth')}
                </Text>
                <TextInput
                  value={editRecurringDay}
                  onChangeText={setEditRecurringDay}
                  keyboardType="numeric"
                  style={[styles.modalInput, { color: tokens.text, borderColor: tokens.border }]}
                />
              </View>
            </View>

            {editRecurringError && (
              <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 12.5, marginTop: 12 }}>
                {editRecurringError}
              </Text>
            )}

            <View style={styles.modalActions}>
              <Pressable onPress={closeEditRecurring} style={[styles.modalBtn, { backgroundColor: tokens.card }]}>
                <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>
                  {t('common.cancel')}
                </Text>
              </Pressable>
              <Pressable
                onPress={saveEditRecurring}
                disabled={editRecurringSaving}
                style={[styles.modalBtn, { backgroundColor: tokens.accent, opacity: editRecurringSaving ? 0.6 : 1 }]}
              >
                <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 14 }}>
                  {editRecurringSaving ? t('common.saving') : t('common.save')}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={editingLongTerm !== null} transparent animationType="fade" onRequestClose={closeEditLongTerm}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.border, maxHeight: '90%' }]}>
            <ScrollView>
              <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 16, marginBottom: 14 }}>
                {t('more.editLongTermTitle')}
              </Text>
              <LongTermForm
                mode="edit"
                embedded
                tokens={tokens}
                t={t}
                categories={categories}
                accounts={accounts}
                ltName={ltName}
                setLtName={setLtName}
                ltCategoryId={ltCategoryId}
                setLtCategoryId={setLtCategoryId}
                ltFullAmount={ltFullAmount}
                setLtFullAmount={setLtFullAmount}
                ltPaymentMonth={ltPaymentMonth}
                setLtPaymentMonth={setLtPaymentMonth}
                ltFirstReserveMonth={ltFirstReserveMonth}
                setLtFirstReserveMonth={setLtFirstReserveMonth}
                ltMode={ltMode}
                setLtMode={setLtMode}
                ltManualReserve={ltManualReserve}
                setLtManualReserve={setLtManualReserve}
                ltOpeningBalance={ltOpeningBalance}
                setLtOpeningBalance={setLtOpeningBalance}
                ltRepeatYearly={ltRepeatYearly}
                setLtRepeatYearly={setLtRepeatYearly}
                ltReserveAccountId={ltReserveAccountId}
                setLtReserveAccountId={setLtReserveAccountId}
                ltTargetPrefix={ltTargetPrefix}
                setLtTargetPrefix={setLtTargetPrefix}
                ltTargetNumber={ltTargetNumber}
                setLtTargetNumber={setLtTargetNumber}
                ltTargetBankCode={ltTargetBankCode}
                setLtTargetBankCode={setLtTargetBankCode}
                ltVariableSymbol={ltVariableSymbol}
                setLtVariableSymbol={setLtVariableSymbol}
                ltPaymentMessage={ltPaymentMessage}
                setLtPaymentMessage={setLtPaymentMessage}
                error={editingLongTermError}
                onCancel={closeEditLongTerm}
                onSave={saveEditLongTerm}
                saving={editingLongTermSaving}
              />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

/** Shared add/edit form for a long-term item — used both as the inline
 * "add" card and inside the edit Modal (`embedded` just drops its own
 * card chrome since the Modal already provides that). */
function LongTermForm(props: {
  mode: 'add' | 'edit';
  embedded?: boolean;
  tokens: ReturnType<typeof useTheme>['tokens'];
  t: (key: string) => string;
  categories: Category[];
  accounts: Account[];
  ltName: string;
  setLtName: (v: string) => void;
  ltCategoryId: string | null;
  setLtCategoryId: (v: string) => void;
  ltFullAmount: string;
  setLtFullAmount: (v: string) => void;
  ltPaymentMonth: string;
  setLtPaymentMonth: (v: string) => void;
  ltFirstReserveMonth: string;
  setLtFirstReserveMonth: (v: string) => void;
  ltMode: ReserveAmountMode;
  setLtMode: (v: ReserveAmountMode) => void;
  ltManualReserve: string;
  setLtManualReserve: (v: string) => void;
  ltOpeningBalance: string;
  setLtOpeningBalance: (v: string) => void;
  ltRepeatYearly: boolean;
  setLtRepeatYearly: (v: boolean) => void;
  ltReserveAccountId: string | null;
  setLtReserveAccountId: (v: string) => void;
  ltTargetPrefix: string;
  setLtTargetPrefix: (v: string) => void;
  ltTargetNumber: string;
  setLtTargetNumber: (v: string) => void;
  ltTargetBankCode: string;
  setLtTargetBankCode: (v: string) => void;
  ltVariableSymbol: string;
  setLtVariableSymbol: (v: string) => void;
  ltPaymentMessage: string;
  setLtPaymentMessage: (v: string) => void;
  error: string | null;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  const { tokens, t } = props;
  return (
    <View
      style={
        props.embedded
          ? undefined
          : [styles.newAccountCard, { backgroundColor: tokens.card, borderColor: tokens.border }]
      }
    >
      <TextInput
        value={props.ltName}
        onChangeText={props.setLtName}
        placeholder={t('more.longTermNamePlaceholder')}
        placeholderTextColor={tokens.textMuted}
        style={[styles.addInput, { color: tokens.text, borderColor: tokens.border, marginBottom: 8 }]}
      />
      <TextInput
        value={props.ltFullAmount}
        onChangeText={props.setLtFullAmount}
        keyboardType="numeric"
        placeholder={t('more.longTermFullAmountPlaceholder')}
        placeholderTextColor={tokens.textMuted}
        style={[styles.addInput, { color: tokens.text, borderColor: tokens.border, marginBottom: 10 }]}
      />

      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginBottom: 6 }}>
        {t('transactions.categoryLabel')}
      </Text>
      <View style={styles.chipRow}>
        {props.categories
          .filter((c) => c.active)
          .map((cat) => (
            <Pressable
              key={cat.id}
              onPress={() => props.setLtCategoryId(cat.id)}
              style={[styles.chip, { backgroundColor: props.ltCategoryId === cat.id ? tokens.accent : tokens.cardAlt }]}
            >
              <Text
                style={{
                  color: props.ltCategoryId === cat.id ? tokens.accentText : tokens.text,
                  fontFamily: fontFamily.semibold,
                  fontSize: 12,
                }}
              >
                {cat.name}
              </Text>
            </Pressable>
          ))}
      </View>

      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginBottom: 6 }}>
            {t('more.longTermFirstReserveMonth')}
          </Text>
          <TextInput
            value={props.ltFirstReserveMonth}
            onChangeText={props.setLtFirstReserveMonth}
            placeholder="2026-02"
            placeholderTextColor={tokens.textMuted}
            style={[styles.addInput, { color: tokens.text, borderColor: tokens.border }]}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginBottom: 6 }}>
            {t('more.longTermPaymentMonth')}
          </Text>
          <TextInput
            value={props.ltPaymentMonth}
            onChangeText={props.setLtPaymentMonth}
            placeholder="2027-01"
            placeholderTextColor={tokens.textMuted}
            style={[styles.addInput, { color: tokens.text, borderColor: tokens.border }]}
          />
        </View>
      </View>

      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 10, marginBottom: 6 }}>
        {t('more.longTermMode')}
      </Text>
      <View style={styles.chipRow}>
        {(['AUTO', 'MANUAL'] as ReserveAmountMode[]).map((mode) => (
          <Pressable
            key={mode}
            onPress={() => props.setLtMode(mode)}
            style={[styles.chip, { backgroundColor: props.ltMode === mode ? tokens.accent : tokens.cardAlt }]}
          >
            <Text
              style={{
                color: props.ltMode === mode ? tokens.accentText : tokens.text,
                fontFamily: fontFamily.semibold,
                fontSize: 12,
              }}
            >
              {mode === 'AUTO' ? t('more.longTermModeAuto') : t('more.longTermModeManual')}
            </Text>
          </Pressable>
        ))}
      </View>

      {props.ltMode === 'MANUAL' && (
        <TextInput
          value={props.ltManualReserve}
          onChangeText={props.setLtManualReserve}
          keyboardType="numeric"
          placeholder={t('more.longTermManualReservePlaceholder')}
          placeholderTextColor={tokens.textMuted}
          style={[styles.addInput, { color: tokens.text, borderColor: tokens.border, marginTop: 8 }]}
        />
      )}

      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginBottom: 6 }}>
            {t('more.longTermOpeningBalance')}
          </Text>
          <TextInput
            value={props.ltOpeningBalance}
            onChangeText={props.setLtOpeningBalance}
            keyboardType="numeric"
            style={[styles.addInput, { color: tokens.text, borderColor: tokens.border }]}
          />
        </View>
        <Pressable
          onPress={() => props.setLtRepeatYearly(!props.ltRepeatYearly)}
          style={[
            styles.chip,
            { backgroundColor: props.ltRepeatYearly ? tokens.accent : tokens.cardAlt, alignSelf: 'flex-end', marginBottom: 2 },
          ]}
        >
          <Text
            style={{
              color: props.ltRepeatYearly ? tokens.accentText : tokens.text,
              fontFamily: fontFamily.semibold,
              fontSize: 12,
            }}
          >
            {t('more.longTermRepeatsYearly')}
          </Text>
        </Pressable>
      </View>

      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 10, marginBottom: 6 }}>
        {t('more.longTermReserveAccount')}
      </Text>
      <View style={styles.chipRow}>
        {props.accounts
          .filter((a) => a.active)
          .map((acc) => (
            <Pressable
              key={acc.id}
              onPress={() => props.setLtReserveAccountId(acc.id)}
              style={[
                styles.chip,
                { backgroundColor: props.ltReserveAccountId === acc.id ? tokens.accent : tokens.cardAlt },
              ]}
            >
              <Text
                style={{
                  color: props.ltReserveAccountId === acc.id ? tokens.accentText : tokens.text,
                  fontFamily: fontFamily.semibold,
                  fontSize: 12,
                }}
              >
                {acc.name}
              </Text>
            </Pressable>
          ))}
      </View>

      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 12, marginBottom: 6 }}>
        {t('more.longTermExternalPayeeHint')}
      </Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput
          value={props.ltTargetPrefix}
          onChangeText={props.setLtTargetPrefix}
          placeholder={t('more.accountPrefixPlaceholder')}
          placeholderTextColor={tokens.textMuted}
          style={[styles.addInput, { color: tokens.text, borderColor: tokens.border, flex: 1 }]}
        />
        <TextInput
          value={props.ltTargetNumber}
          onChangeText={props.setLtTargetNumber}
          placeholder={t('more.accountNumberPlaceholder')}
          placeholderTextColor={tokens.textMuted}
          style={[styles.addInput, { color: tokens.text, borderColor: tokens.border, flex: 2 }]}
        />
        <TextInput
          value={props.ltTargetBankCode}
          onChangeText={props.setLtTargetBankCode}
          placeholder={t('more.bankCodePlaceholder')}
          placeholderTextColor={tokens.textMuted}
          style={[styles.addInput, { color: tokens.text, borderColor: tokens.border, flex: 1 }]}
        />
      </View>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        <TextInput
          value={props.ltVariableSymbol}
          onChangeText={props.setLtVariableSymbol}
          placeholder={t('more.longTermVariableSymbolPlaceholder')}
          placeholderTextColor={tokens.textMuted}
          style={[styles.addInput, { color: tokens.text, borderColor: tokens.border, flex: 1 }]}
        />
        <TextInput
          value={props.ltPaymentMessage}
          onChangeText={props.setLtPaymentMessage}
          placeholder={t('more.longTermMessagePlaceholder')}
          placeholderTextColor={tokens.textMuted}
          style={[styles.addInput, { color: tokens.text, borderColor: tokens.border, flex: 2 }]}
        />
      </View>

      {props.error && (
        <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 12.5, marginTop: 10 }}>
          {props.error}
        </Text>
      )}

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
        <Pressable onPress={props.onCancel} style={[styles.modalBtn, { backgroundColor: tokens.cardAlt }]}>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13 }}>{t('common.cancel')}</Text>
        </Pressable>
        <Pressable
          onPress={props.onSave}
          disabled={props.saving}
          style={[styles.modalBtn, { backgroundColor: tokens.accent, opacity: props.saving ? 0.6 : 1 }]}
        >
          <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 13 }}>
            {props.saving ? t('common.saving') : t('common.save')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 },
  wizardBtn: { paddingHorizontal: 16, paddingVertical: 11, borderRadius: 10 },
  section: { marginBottom: 30 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
    gap: 8,
  },
  ltCard: { borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 10 },
  ltCardTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  barTrack: { height: 8, borderRadius: 4, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
  smallBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9 },
  addInput: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  addBtn: { paddingHorizontal: 16, paddingVertical: 11, borderRadius: 10, justifyContent: 'center' },
  newAccountCard: { borderWidth: 1, borderRadius: 14, padding: 14, marginTop: 4 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9 },
  dueBanner: { borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 12 },
  dueRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  dueAmountInput: { width: 70, borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, fontSize: 12.5 },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 440,
    borderRadius: 18,
    borderWidth: 1,
    padding: 20,
  },
  modalInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 20 },
  modalBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
});
