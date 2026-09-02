import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { useAuth } from '@/lib/auth-context';
import { useLanguage } from '@/lib/language-context';
import { supabase } from '@/lib/supabase';
import { isPushSupported, subscribeToPush, unsubscribeFromPush, getPushSubscriptionState } from '@/lib/push';
import type { Language } from '@/lib/i18n';
import type { Account, AccountType, Category } from '@/types/database';

const DEFAULT_AMOUNT_BUTTONS = [20, 50, 100, 200];

/** Quick-amount chips are shown with an explicit sign — "+20" for a
 * shortcut that adds to the amount, "−50" for one that lowers it — since a
 * bare "+" prefix on every value would otherwise render a negative
 * shortcut as the confusing "+-50". */
function formatAmountButton(value: number): string {
  return value >= 0 ? `+${value}` : `−${Math.abs(value)}`;
}

function ChevronIcon({ expanded, color }: { expanded: boolean; color: string }) {
  return (
    <View style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }}>
      <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M6 9l6 6 6-6" />
      </Svg>
    </View>
  );
}

// Deliberately a module-level component, NOT one defined inside Settings()
// itself — a component defined inside another component's render body gets
// a brand-new function identity every render, so React unmounts and
// remounts its whole subtree on every re-render of the parent rather than
// patching it in place. Every text input below (new category, new
// account, new quick-amount) lives inside a Section, and losing focus
// after every single keystroke would have made them nearly unusable —
// this is what keeps that from happening. Theme colors come in as props
// rather than a closure over `tokens` for the same reason.
function Section({
  expanded,
  onToggle,
  title,
  description,
  titleColor,
  descColor,
  chevronColor,
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  title: string;
  description: string;
  titleColor: string;
  descColor: string;
  chevronColor: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Pressable onPress={onToggle} style={styles.sectionHeaderRow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: titleColor, fontFamily: fontFamily.extrabold, fontSize: 16 }}>{title}</Text>
          <Text style={{ color: descColor, fontFamily: fontFamily.medium, fontSize: 12, marginTop: 2 }}>
            {description}
          </Text>
        </View>
        <ChevronIcon expanded={expanded} color={chevronColor} />
      </Pressable>
      {expanded && <View style={{ marginTop: 14 }}>{children}</View>}
    </View>
  );
}

/**
 * Settings (formerly "More") — pure configuration, deliberately no
 * transactional functionality here. Categories, Accounts, Quick amounts,
 * Language, Budget month, and Notifications.
 *
 * This is a UX split Pavel asked for after Phase 2: anything you *act on*
 * regularly — confirming a due recurring item, generating a QR for a
 * long-term payment — moved to its own "Planning" tab (app/(app)/
 * planning.tsx). Settings is "configure once, rarely touch"; Planning is
 * "the stuff I check and act on."
 *
 * Collapsible sections (Pavel's later request): six sections, each a
 * pressable header (title + a one-line explanation right next to it,
 * always visible even collapsed) that toggles its own body. All start
 * collapsed — `expandedSections` is empty on mount — since this whole
 * screen is "configure once, rarely touch" by design; nothing here needs
 * to be open by default. Language and Budget month used to be two rows
 * inside one combined "Profile & preferences" section; they're now their
 * own top-level sections (also Pavel's request), and what's left —
 * Notifications — got promoted to a section of its own rather than
 * staying a leftover one-row group under a now-empty combined heading.
 *
 * Archive rather than delete: both tables already have an `active` boolean
 * in the schema (supabase/migrations/0001_initial_schema.sql) specifically
 * for this — a category or account that's been used by real transactions
 * shouldn't disappear outright (it'd orphan history), so "Archive" just
 * hides it from the picker chips elsewhere. This screen is the one place
 * that also shows archived ones, toggle-able — that toggle now lives
 * inside each section's collapsed-away body (not the always-visible
 * header row) so tapping it doesn't also trigger the header's own
 * expand/collapse press (nested Pressables bubble on web).
 *
 * Accounts carry the Czech bank fields (prefix/number/bank code) used by
 * lib/czech-qr-payment.ts for debt and long-term-payment QR codes — filled
 * in only for real bank accounts, left blank for Cash.
 *
 * Quick amounts (new): profile.amount_buttons — previously hardcoded as
 * [20, 50, 100, 200] in components/ExpenseEntryForm.tsx with a literal
 * TODO pointing at this screen. Editable here as add/remove chips, read
 * everywhere else via lib/use-app-data.ts's `amountButtons`.
 */
export default function Settings() {
  const { tokens } = useTheme();
  const { user, signOut } = useAuth();
  const { language, setLanguage, t } = useLanguage();

  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [defaultAccountId, setDefaultAccountId] = useState<string | null>(null);
  const [monthStartDay, setMonthStartDay] = useState(1);
  const [savingMonthStartDay, setSavingMonthStartDay] = useState(false);
  const [amountButtons, setAmountButtons] = useState<number[]>(DEFAULT_AMOUNT_BUTTONS);
  const [newAmount, setNewAmount] = useState('');
  const [savingAmountButtons, setSavingAmountButtons] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showArchivedCategories, setShowArchivedCategories] = useState(false);
  const [showArchivedAccounts, setShowArchivedAccounts] = useState(false);

  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  function toggleSection(id: string) {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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

  const [pushSupported, setPushSupported] = useState(false);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [categoriesRes, accountsRes, profileRes] = await Promise.all([
      supabase.from('categories').select('*').eq('owner_id', user.id).order('sort_order'),
      supabase.from('accounts').select('*').eq('owner_id', user.id).order('sort_order'),
      supabase.from('profile').select('default_account_id, month_start_day, amount_buttons').eq('id', user.id).maybeSingle(),
    ]);
    setCategories(categoriesRes.data ?? []);
    setAccounts(accountsRes.data ?? []);
    setDefaultAccountId(profileRes.data?.default_account_id ?? null);
    setMonthStartDay(profileRes.data?.month_start_day ?? 1);
    setAmountButtons(
      profileRes.data?.amount_buttons && profileRes.data.amount_buttons.length > 0
        ? profileRes.data.amount_buttons
        : DEFAULT_AMOUNT_BUTTONS
    );
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

  /** 1–28, matching the schema's check constraint (chosen so it's always a
   * valid day regardless of month length) — see lib/budget-month.ts for
   * what this actually changes. */
  async function changeMonthStartDay(next: number) {
    if (!user) return;
    const clamped = Math.min(28, Math.max(1, next));
    setMonthStartDay(clamped);
    setSavingMonthStartDay(true);
    await supabase.from('profile').update({ month_start_day: clamped }).eq('id', user.id);
    setSavingMonthStartDay(false);
  }

  async function saveAmountButtons(next: number[]) {
    if (!user) return;
    setAmountButtons(next);
    setSavingAmountButtons(true);
    await supabase.from('profile').update({ amount_buttons: next }).eq('id', user.id);
    setSavingAmountButtons(false);
  }

  function removeAmountButton(value: number) {
    if (amountButtons.length <= 1) return; // keep at least one shortcut
    saveAmountButtons(amountButtons.filter((v) => v !== value));
  }

  function addAmountButton() {
    const trimmed = newAmount.trim();
    const value = Number(trimmed);
    // Negative shortcuts are allowed (Pavel: "sometimes we might need to
    // lower the amount") — only zero, blank/NaN input, and duplicates are
    // rejected. Display of negative chips is handled by formatAmountButton
    // below, since a bare "+" prefix would otherwise read as "+-50".
    if (!trimmed || Number.isNaN(value) || value === 0 || amountButtons.includes(value)) {
      setNewAmount('');
      return;
    }
    saveAmountButtons([...amountButtons, value].sort((a, b) => a - b));
    setNewAmount('');
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
        {t('more.settingsTitle')}
      </Text>

      {loading ? (
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium }}>{t('common.loading')}</Text>
      ) : (
        <>
          <Section
            expanded={expandedSections.has('categories')}
            onToggle={() => toggleSection('categories')}
            title={t('more.categories')}
            description={t('more.categoriesSectionDesc')}
            titleColor={tokens.text}
            descColor={tokens.textMuted}
            chevronColor={tokens.textMuted}
          >
            <View style={styles.archiveToggleRow}>
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
          </Section>

          <Section
            expanded={expandedSections.has('accounts')}
            onToggle={() => toggleSection('accounts')}
            title={t('more.accounts')}
            description={t('more.accountsSectionDesc')}
            titleColor={tokens.text}
            descColor={tokens.textMuted}
            chevronColor={tokens.textMuted}
          >
            <View style={styles.archiveToggleRow}>
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
          </Section>

          <Section
            expanded={expandedSections.has('quickAmounts')}
            onToggle={() => toggleSection('quickAmounts')}
            title={t('more.quickAmountsTitle')}
            description={t('more.quickAmountsSectionDesc')}
            titleColor={tokens.text}
            descColor={tokens.textMuted}
            chevronColor={tokens.textMuted}
          >
            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginBottom: 10 }}>
              {t('more.quickAmountsHint')}
            </Text>
            <View style={styles.chipRow}>
              {amountButtons.map((value) => (
                <View key={value} style={[styles.amountChip, { backgroundColor: tokens.cardAlt }]}>
                  <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13 }}>
                    {formatAmountButton(value)}
                  </Text>
                  <Pressable
                    onPress={() => removeAmountButton(value)}
                    disabled={savingAmountButtons || amountButtons.length <= 1}
                    hitSlop={6}
                  >
                    <Text
                      style={{
                        color: amountButtons.length <= 1 ? tokens.textMuted : tokens.coral,
                        fontFamily: fontFamily.bold,
                        fontSize: 13,
                        marginLeft: 6,
                        opacity: amountButtons.length <= 1 ? 0.4 : 1,
                      }}
                    >
                      ×
                    </Text>
                  </Pressable>
                </View>
              ))}
            </View>
            <View style={styles.addRow}>
              <TextInput
                value={newAmount}
                onChangeText={setNewAmount}
                // Plain "numeric"/"decimal-pad" keyboards hide the minus
                // sign on iOS and most Android keyboards, which would make
                // negative shortcuts untypeable there — "default" trades
                // away the numeric-only keypad (Pavel's primary use is
                // desktop web anyway) so "-50" can always be typed;
                // addAmountButton() still validates/parses the result.
                keyboardType="default"
                placeholder={t('more.addAmountPlaceholder')}
                placeholderTextColor={tokens.textMuted}
                style={[styles.addInput, { color: tokens.text, borderColor: tokens.border }]}
                onSubmitEditing={addAmountButton}
              />
              <Pressable
                onPress={addAmountButton}
                disabled={savingAmountButtons || !newAmount.trim()}
                style={[styles.addBtn, { backgroundColor: tokens.accent, opacity: newAmount.trim() ? 1 : 0.5 }]}
              >
                <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 13 }}>
                  {t('more.saveNew')}
                </Text>
              </Pressable>
            </View>
          </Section>

          <Section
            expanded={expandedSections.has('language')}
            onToggle={() => toggleSection('language')}
            title={t('more.language')}
            description={t('more.languageSectionDesc')}
            titleColor={tokens.text}
            descColor={tokens.textMuted}
            chevronColor={tokens.textMuted}
          >
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
          </Section>

          <Section
            expanded={expandedSections.has('budgetMonth')}
            onToggle={() => toggleSection('budgetMonth')}
            title={t('more.budgetMonthTitle')}
            description={t('more.budgetMonthSectionDesc')}
            titleColor={tokens.text}
            descColor={tokens.textMuted}
            chevronColor={tokens.textMuted}
          >
            <View style={[styles.row, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>
                  {t('more.monthStartDay')}
                </Text>
                <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 2 }}>
                  {t('more.monthStartDayHint')}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Pressable
                  onPress={() => changeMonthStartDay(monthStartDay - 1)}
                  disabled={savingMonthStartDay || monthStartDay <= 1}
                  style={[styles.smallBtn, { backgroundColor: tokens.cardAlt, opacity: monthStartDay <= 1 ? 0.4 : 1 }]}
                >
                  <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 13 }}>−</Text>
                </Pressable>
                <Text
                  style={{
                    color: tokens.text,
                    fontFamily: fontFamily.bold,
                    fontSize: 14,
                    width: 28,
                    textAlign: 'center',
                  }}
                >
                  {monthStartDay}
                </Text>
                <Pressable
                  onPress={() => changeMonthStartDay(monthStartDay + 1)}
                  disabled={savingMonthStartDay || monthStartDay >= 28}
                  style={[styles.smallBtn, { backgroundColor: tokens.cardAlt, opacity: monthStartDay >= 28 ? 0.4 : 1 }]}
                >
                  <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 13 }}>+</Text>
                </Pressable>
              </View>
            </View>
          </Section>

          {pushSupported && (
            <Section
              expanded={expandedSections.has('notifications')}
              onToggle={() => toggleSection('notifications')}
              title={t('more.notifications')}
              description={t('more.notificationsSectionDesc')}
              titleColor={tokens.text}
              descColor={tokens.textMuted}
              chevronColor={tokens.textMuted}
            >
              <View style={[styles.row, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
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
            </Section>
          )}
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 22 },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  archiveToggleRow: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 8 },
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
  amountChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 9,
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 16,
    marginTop: 6,
    borderTopWidth: 1,
  },
  signOutBtn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10 },
});
