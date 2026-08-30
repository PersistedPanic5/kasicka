import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { useAuth } from '@/lib/auth-context';
import { useLanguage } from '@/lib/language-context';
import { supabase } from '@/lib/supabase';
import { computeDueRecurringItems, confirmRecurringItem, type ConfirmedRecurringTx } from '@/lib/recurring';
import { isPushSupported, subscribeToPush, unsubscribeFromPush, getPushSubscriptionState } from '@/lib/push';
import type { Language } from '@/lib/i18n';
import type { Account, AccountType, Category, RecurringFrequency, RecurringItem } from '@/types/database';

/**
 * More → the settings hub: Categories, Accounts, and Profile & preferences
 * (language + sign out) — the Phase 1 "Categories & Accounts CRUD" item
 * from build-roadmap-v1.md, built alongside the localization pass since
 * Pavel asked for both together.
 *
 * Archive rather than delete: both tables already have an `active` boolean
 * in the schema (supabase/migrations/0001_initial_schema.sql) specifically
 * for this — a category or account that's been used by real transactions
 * shouldn't disappear outright (it'd orphan history), so "Archive" just
 * hides it from the picker chips elsewhere (ExpenseEntryForm etc. already
 * filter `.eq('active', true)` implicitly via category_type; this screen
 * is the one place that also shows archived ones, toggle-able, so nothing
 * is ever silently unrecoverable).
 *
 * Accounts carry the Czech bank fields (prefix/number/bank code) used by
 * lib/czech-qr-payment.ts for debt QR codes — filled in only for real bank
 * accounts, left blank for Cash.
 */
export default function More() {
  const { tokens } = useTheme();
  const { user, signOut } = useAuth();
  const { language, setLanguage, t } = useLanguage();

  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [defaultAccountId, setDefaultAccountId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showArchivedCategories, setShowArchivedCategories] = useState(false);
  const [showArchivedAccounts, setShowArchivedAccounts] = useState(false);

  const [newCategoryName, setNewCategoryName] = useState('');
  const [addingCategory, setAddingCategory] = useState(false);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState('');
  const [savingCategoryRename, setSavingCategoryRename] = useState(false);

  const [newAccountName, setNewAccountName] = useState('');
  const [newAccountType, setNewAccountType] = useState<AccountType>('BANK');
  const [newAccountPrefix, setNewAccountPrefix] = useState('');
  const [newAccountNumber, setNewAccountNumber] = useState('');
  const [newAccountBankCode, setNewAccountBankCode] = useState('');
  const [addingAccount, setAddingAccount] = useState(false);

  // ── Recurring items (Phase 2) ─────────────────────────────────────────
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

  // ── Web Push (Phase 2) ────────────────────────────────────────────────
  const [pushSupported, setPushSupported] = useState(false);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const yearStart = `${new Date().getFullYear()}-01-01`;
    const [categoriesRes, accountsRes, profileRes, recurringRes, recurringTxRes] = await Promise.all([
      supabase.from('categories').select('*').eq('owner_id', user.id).order('sort_order'),
      supabase.from('accounts').select('*').eq('owner_id', user.id).order('sort_order'),
      supabase.from('profile').select('default_account_id').eq('id', user.id).maybeSingle(),
      supabase.from('recurring_items').select('*').eq('owner_id', user.id).order('name'),
      supabase
        .from('transactions')
        .select('recurring_item_id, transaction_date')
        .eq('owner_id', user.id)
        .not('recurring_item_id', 'is', null)
        .gte('transaction_date', yearStart),
    ]);
    setCategories(categoriesRes.data ?? []);
    setAccounts(accountsRes.data ?? []);
    setDefaultAccountId(profileRes.data?.default_account_id ?? null);
    setRecurringItems(recurringRes.data ?? []);
    setRecurringConfirmedTx((recurringTxRes.data ?? []) as ConfirmedRecurringTx[]);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    setPushSupported(isPushSupported());
    getPushSubscriptionState().then(setPushSubscribed);
  }, []);

  async function addCategory() {
    if (!user || !newCategoryName.trim()) return;
    setAddingCategory(true);
    await supabase.from('categories').insert({
      owner_id: user.id,
      name: newCategoryName.trim(),
      category_type: 'EXPENSE',
      sort_order: categories.length,
    });
    setNewCategoryName('');
    setAddingCategory(false);
    load();
  }

  async function toggleCategoryActive(cat: Category) {
    await supabase.from('categories').update({ active: !cat.active }).eq('id', cat.id);
    load();
  }

  function startEditCategory(cat: Category) {
    setEditingCategoryId(cat.id);
    setEditingCategoryName(cat.name);
  }

  function cancelEditCategory() {
    setEditingCategoryId(null);
    setEditingCategoryName('');
  }

  async function saveCategoryRename() {
    const name = editingCategoryName.trim();
    if (!editingCategoryId || !name) return;
    setSavingCategoryRename(true);
    await supabase.from('categories').update({ name }).eq('id', editingCategoryId);
    setSavingCategoryRename(false);
    setEditingCategoryId(null);
    setEditingCategoryName('');
    load();
  }

  async function addAccount() {
    if (!user || !newAccountName.trim()) return;
    setAddingAccount(true);
    await supabase.from('accounts').insert({
      owner_id: user.id,
      name: newAccountName.trim(),
      account_type: newAccountType,
      account_prefix: newAccountPrefix.trim() || null,
      account_number: newAccountNumber.trim() || null,
      bank_code: newAccountBankCode.trim() || null,
      sort_order: accounts.length,
    });
    setNewAccountName('');
    setNewAccountPrefix('');
    setNewAccountNumber('');
    setNewAccountBankCode('');
    setNewAccountType('BANK');
    setAddingAccount(false);
    load();
  }

  async function toggleAccountActive(acc: Account) {
    await supabase.from('accounts').update({ active: !acc.active }).eq('id', acc.id);
    load();
  }

  async function makeDefault(accountId: string) {
    if (!user) return;
    setDefaultAccountId(accountId);
    await supabase.from('profile').update({ default_account_id: accountId }).eq('id', user.id);
  }

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

  async function togglePush() {
    if (!user) return;
    setPushBusy(true);
    setPushError(null);
    try {
      if (pushSubscribed) {
        await unsubscribeFromPush(user.id);
        setPushSubscribed(false);
      } else {
        await subscribeToPush(user.id);
        setPushSubscribed(true);
      }
    } catch (err) {
      setPushError(err instanceof Error ? err.message : String(err));
    }
    setPushBusy(false);
  }

  const visibleCategories = categories.filter((c) => (showArchivedCategories ? true : c.active));
  const visibleAccounts = accounts.filter((a) => (showArchivedAccounts ? true : a.active));
  const visibleRecurring = recurringItems.filter((r) => (showArchivedRecurring ? true : r.active));
  const categoryNameById = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  const accountNameById = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);
  const dueRecurringItems = useMemo(
    () => computeDueRecurringItems(recurringItems, recurringConfirmedTx),
    [recurringItems, recurringConfirmedTx]
  );

  const accountTypes: AccountType[] = ['BANK', 'CASH', 'SAVINGS', 'RESERVE', 'CARD'];
  const accountTypeLabel: Record<AccountType, string> = {
    BANK: t('more.accountTypeBank'),
    CASH: t('more.accountTypeCash'),
    SAVINGS: t('more.accountTypeSavings'),
    RESERVE: t('more.accountTypeReserve'),
    CARD: t('more.accountTypeCard'),
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 60 }}>
      <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 24, marginBottom: 24 }}>
        {t('more.title')}
      </Text>

      {loading ? (
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium }}>{t('common.loading')}</Text>
      ) : (
        <>
          {/* ── Categories ──────────────────────────────────────────── */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 16 }}>
                {t('more.categories')}
              </Text>
              <Pressable onPress={() => setShowArchivedCategories((v) => !v)}>
                <Text style={{ color: tokens.accent, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                  {showArchivedCategories ? t('more.active') : t('more.archived')}
                </Text>
              </Pressable>
            </View>

            {visibleCategories.length === 0 && (
              <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13, marginBottom: 10 }}>
                {t('more.noCategories')}
              </Text>
            )}
            {visibleCategories.map((cat) =>
              editingCategoryId === cat.id ? (
                <View key={cat.id} style={[styles.row, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
                  <TextInput
                    value={editingCategoryName}
                    onChangeText={setEditingCategoryName}
                    autoFocus
                    placeholder={t('more.categoryNamePlaceholder')}
                    placeholderTextColor={tokens.textMuted}
                    style={[styles.addInput, { color: tokens.text, borderColor: tokens.border, flex: 1 }]}
                    onSubmitEditing={saveCategoryRename}
                  />
                  <Pressable
                    onPress={saveCategoryRename}
                    disabled={savingCategoryRename || !editingCategoryName.trim()}
                    style={[styles.smallBtn, { backgroundColor: tokens.accent }]}
                  >
                    <Text style={{ color: tokens.accentText, fontFamily: fontFamily.semibold, fontSize: 12 }}>
                      {t('common.save')}
                    </Text>
                  </Pressable>
                  <Pressable onPress={cancelEditCategory} style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}>
                    <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12 }}>
                      {t('common.cancel')}
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <View key={cat.id} style={[styles.row, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
                  <Text
                    style={{
                      color: cat.active ? tokens.text : tokens.textMuted,
                      fontFamily: fontFamily.semibold,
                      fontSize: 14,
                      flex: 1,
                    }}
                  >
                    {cat.name}
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    {cat.active && (
                      <Pressable
                        onPress={() => startEditCategory(cat)}
                        style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}
                      >
                        <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12 }}>
                          {t('more.rename')}
                        </Text>
                      </Pressable>
                    )}
                    <Pressable
                      onPress={() => toggleCategoryActive(cat)}
                      style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}
                    >
                      <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12 }}>
                        {cat.active ? t('more.archive') : t('more.unarchive')}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              )
            )}

            <View style={styles.addRow}>
              <TextInput
                value={newCategoryName}
                onChangeText={setNewCategoryName}
                placeholder={t('more.categoryNamePlaceholder')}
                placeholderTextColor={tokens.textMuted}
                style={[styles.addInput, { color: tokens.text, borderColor: tokens.border }]}
              />
              <Pressable
                onPress={addCategory}
                disabled={addingCategory || !newCategoryName.trim()}
                style={[styles.addBtn, { backgroundColor: tokens.accent, opacity: newCategoryName.trim() ? 1 : 0.5 }]}
              >
                <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 13 }}>
                  {t('more.saveNew')}
                </Text>
              </Pressable>
            </View>
          </View>

          {/* ── Accounts ────────────────────────────────────────────── */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 16 }}>
                {t('more.accounts')}
              </Text>
              <Pressable onPress={() => setShowArchivedAccounts((v) => !v)}>
                <Text style={{ color: tokens.accent, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                  {showArchivedAccounts ? t('more.active') : t('more.archived')}
                </Text>
              </Pressable>
            </View>

            {visibleAccounts.length === 0 && (
              <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13, marginBottom: 10 }}>
                {t('more.noAccounts')}
              </Text>
            )}
            {visibleAccounts.map((acc) => (
              <View
                key={acc.id}
                style={[styles.row, { backgroundColor: tokens.card, borderColor: tokens.border, flexWrap: 'wrap' }]}
              >
                <View style={{ flex: 1, minWidth: 140 }}>
                  <Text
                    style={{
                      color: acc.active ? tokens.text : tokens.textMuted,
                      fontFamily: fontFamily.semibold,
                      fontSize: 14,
                    }}
                  >
                    {acc.name} {defaultAccountId === acc.id ? `· ${t('more.default')}` : ''}
                  </Text>
                  <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 2 }}>
                    {accountTypeLabel[acc.account_type]}
                    {acc.account_number ? ` · ${acc.account_prefix ? `${acc.account_prefix}-` : ''}${acc.account_number}/${acc.bank_code ?? ''}` : ''}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  {defaultAccountId !== acc.id && acc.active && (
                    <Pressable
                      onPress={() => makeDefault(acc.id)}
                      style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}
                    >
                      <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12 }}>
                        {t('more.makeDefault')}
                      </Text>
                    </Pressable>
                  )}
                  <Pressable
                    onPress={() => toggleAccountActive(acc)}
                    style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}
                  >
                    <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12 }}>
                      {acc.active ? t('more.archive') : t('more.unarchive')}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ))}

            <View style={[styles.newAccountCard, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
              <TextInput
                value={newAccountName}
                onChangeText={setNewAccountName}
                placeholder={t('more.accountNamePlaceholder')}
                placeholderTextColor={tokens.textMuted}
                style={[styles.addInput, { color: tokens.text, borderColor: tokens.border, marginBottom: 8 }]}
              />
              <View style={styles.chipRow}>
                {accountTypes.map((type) => (
                  <Pressable
                    key={type}
                    onPress={() => setNewAccountType(type)}
                    style={[
                      styles.chip,
                      { backgroundColor: newAccountType === type ? tokens.accent : tokens.cardAlt },
                    ]}
                  >
                    <Text
                      style={{
                        color: newAccountType === type ? tokens.accentText : tokens.text,
                        fontFamily: fontFamily.semibold,
                        fontSize: 12,
                      }}
                    >
                      {accountTypeLabel[type]}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {newAccountType !== 'CASH' && (
                <>
                  <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 10, marginBottom: 6 }}>
                    {t('more.bankDetailsHint')}
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TextInput
                      value={newAccountPrefix}
                      onChangeText={setNewAccountPrefix}
                      placeholder={t('more.accountPrefixPlaceholder')}
                      placeholderTextColor={tokens.textMuted}
                      style={[styles.addInput, { color: tokens.text, borderColor: tokens.border, flex: 1 }]}
                    />
                    <TextInput
                      value={newAccountNumber}
                      onChangeText={setNewAccountNumber}
                      placeholder={t('more.accountNumberPlaceholder')}
                      placeholderTextColor={tokens.textMuted}
                      style={[styles.addInput, { color: tokens.text, borderColor: tokens.border, flex: 2 }]}
                    />
                    <TextInput
                      value={newAccountBankCode}
                      onChangeText={setNewAccountBankCode}
                      placeholder={t('more.bankCodePlaceholder')}
                      placeholderTextColor={tokens.textMuted}
                      style={[styles.addInput, { color: tokens.text, borderColor: tokens.border, flex: 1 }]}
                    />
                  </View>
                </>
              )}

              <Pressable
                onPress={addAccount}
                disabled={addingAccount || !newAccountName.trim()}
                style={[
                  styles.addBtn,
                  { backgroundColor: tokens.accent, opacity: newAccountName.trim() ? 1 : 0.5, marginTop: 10, alignSelf: 'flex-start' },
                ]}
              >
                <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 13 }}>
                  {t('more.addAccount')}
                </Text>
              </Pressable>
            </View>
          </View>

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

          {/* ── Profile & preferences ───────────────────────────────── */}
          <View style={styles.section}>
            <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 16, marginBottom: 12 }}>
              {t('more.profilePreferences')}
            </Text>
            <View style={[styles.row, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
              <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14, flex: 1 }}>
                {t('more.language')}
              </Text>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {(['en', 'cs'] as Language[]).map((lang) => (
                  <Pressable
                    key={lang}
                    onPress={() => setLanguage(lang)}
                    style={[
                      styles.smallBtn,
                      { backgroundColor: language === lang ? tokens.accent : tokens.cardAlt },
                    ]}
                  >
                    <Text
                      style={{
                        color: language === lang ? tokens.accentText : tokens.text,
                        fontFamily: fontFamily.semibold,
                        fontSize: 12,
                      }}
                    >
                      {lang === 'en' ? 'English' : 'Čeština'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {pushSupported && (
              <View style={[styles.row, { backgroundColor: tokens.card, borderColor: tokens.border, marginTop: 8 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>
                    {t('more.notifications')}
                  </Text>
                  <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 2 }}>
                    {t('more.notificationsHint')}
                  </Text>
                  {pushError && (
                    <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 4 }}>
                      {pushError}
                    </Text>
                  )}
                </View>
                <Pressable
                  onPress={togglePush}
                  disabled={pushBusy}
                  style={[
                    styles.smallBtn,
                    { backgroundColor: pushSubscribed ? tokens.cardAlt : tokens.accent, opacity: pushBusy ? 0.6 : 1 },
                  ]}
                >
                  <Text
                    style={{
                      color: pushSubscribed ? tokens.text : tokens.accentText,
                      fontFamily: fontFamily.semibold,
                      fontSize: 12,
                    }}
                  >
                    {pushSubscribed ? t('more.notificationsOn') : t('more.notificationsOff')}
                  </Text>
                </Pressable>
              </View>
            )}
          </View>
        </>
      )}

      <View style={[styles.accountRow, { borderTopColor: tokens.border }]}>
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13 }}>
          {t('more.signedInAs')} {user?.email ?? '…'}
        </Text>
        <Pressable onPress={signOut} style={[styles.signOutBtn, { backgroundColor: tokens.card }]}>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13 }}>{t('more.signOut')}</Text>
        </Pressable>
      </View>

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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
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
  smallBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9 },
  addRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  addInput: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  addBtn: { paddingHorizontal: 16, paddingVertical: 11, borderRadius: 10, justifyContent: 'center' },
  newAccountCard: { borderWidth: 1, borderRadius: 14, padding: 14, marginTop: 4 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9 },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 16,
    marginTop: 6,
    borderTopWidth: 1,
  },
  signOutBtn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10 },
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
