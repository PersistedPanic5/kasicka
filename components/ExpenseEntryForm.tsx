import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth-context';
import { useAppData } from '@/lib/use-app-data';
import { useLanguage } from '@/lib/language-context';
import { budgetMonthForDate } from '@/lib/budget-month';
import { ensureRate, toCzk, type ResolvedRate } from '@/lib/exchange-rates';
import {
  createDebtsForSplit,
  emptySplitPerson,
  newSplitPersonId,
  splitEvenly,
  splitPeopleSum,
  validSplitPeople,
  type SplitPerson,
} from '@/lib/split-people';

const WEEKDAY_SHORT_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_SHORT_CS = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];
const MONTH_SHORT_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Wed 3 Sep" / "St 3. 9." — the short weekday+date shown in brackets next
 * to Today/Tomorrow/±N days (Pavel's request), so the day shifter is never
 * ambiguous about which actual date it landed on. */
function formatShortDate(iso: string, language: 'en' | 'cs'): string {
  const d = new Date(`${iso}T00:00:00`);
  const weekday = language === 'cs' ? WEEKDAY_SHORT_CS[d.getDay()] : WEEKDAY_SHORT_EN[d.getDay()];
  const day = d.getDate();
  return language === 'cs' ? `${weekday} ${day}. ${d.getMonth() + 1}.` : `${weekday} ${day} ${MONTH_SHORT_EN[d.getMonth()]}`;
}

/**
 * The fast expense-capture form — the single most important screen in the
 * app (see screens-and-flows.md "Core UX principle"). Used both by the
 * mobile fast-entry screen (compact) and the desktop Home tab (roomier),
 * via the `variant` prop, so the core action never has two implementations
 * to keep in sync.
 *
 * Phase 1: real save, a note field, plus the "split part of this with
 * someone" debt panel (debts-ledger-requirements.md "Mechanism") — the
 * full transaction amount is always what actually left your account and
 * counts as spend; the split amount just additionally creates a `debts`
 * row against the same transaction, pointing at the debtor's own
 * shareable link (app/d/[token].tsx). The note travels two ways: it's
 * shown as the transaction's own label (app/(app)/transactions.tsx), and
 * — via get_debt_by_share_token's fallback order (see
 * supabase/migrations/0003_debt_message.sql) — becomes the debt's public
 * description/QR message too, unless the split panel's own "message"
 * field overrides it for that debt specifically. account_id/category_id
 * come from useAppData (the signed-in user's bootstrap-created default
 * account + expense categories — see lib/bootstrap.ts).
 *
 * The collapsed "more options" panel (account/photo) — the last piece of
 * Phase 1, per build-roadmap-v1.md — is a single toggle revealing: an
 * account pill-switcher (defaults to profile.default_account_id, same as
 * before, just now overridable per-entry) and a receipt photo capture.
 * Photo capture is web-only for now (a plain hidden <input type="file"
 * capture="environment"> — the standard way to hit the phone camera from a
 * PWA without a native module); a native picker (expo-image-picker) is a
 * follow-up once a real native build exists, matching the PWA-first
 * decision in architecture-v1.md. The file uploads straight to the private
 * "receipts" Supabase Storage bucket (supabase/migrations/
 * 0004_recurring_and_push.sql) under a <user_id>/<filename> path, and the
 * returned storage *path* (not a public URL — the bucket isn't public) is
 * what's saved to transactions.receipt_photo_url; viewing it later means
 * generating a signed URL from that path.
 */
export function ExpenseEntryForm({ variant = 'mobile' }: { variant?: 'mobile' | 'desktop' }) {
  const { tokens } = useTheme();
  const { t, language } = useLanguage();
  const { user } = useAuth();
  const { defaultAccountId, categories, accounts, monthStartDay, amountButtons, activeCurrencies, loading: dataLoading } = useAppData();

  const [entryType, setEntryType] = useState<'EXPENSE' | 'INCOME'>('EXPENSE');
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [dayOffset, setDayOffset] = useState(0);
  const [note, setNote] = useState('');

  // ── Currency (Pavel's request) ──────────────────────────────────────
  const [currency, setCurrency] = useState('CZK');
  const [rateInfo, setRateInfo] = useState<ResolvedRate | null>(null);
  const [rateLoading, setRateLoading] = useState(false);
  const [rateError, setRateError] = useState<string | null>(null);

  // ── Split with someone(s) (Pavel's multi-person rebuild) ────────────
  const [splitEnabled, setSplitEnabled] = useState(false);
  const [splitTotalAmount, setSplitTotalAmount] = useState('');
  const [splitMessage, setSplitMessage] = useState('');
  const [splitPeople, setSplitPeople] = useState<SplitPerson[]>([emptySplitPerson()]);

  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [shareLinks, setShareLinks] = useState<{ name: string; link: string }[]>([]);
  const [copiedLinkIdx, setCopiedLinkIdx] = useState<number | null>(null);

  const [showMoreOptions, setShowMoreOptions] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [photoPath, setPhotoPath] = useState<string | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Categories load asynchronously right after sign-in (first-run
  // bootstrap creates them) — default to the first one once they arrive.
  const activeCategoryId = categoryId ?? categories[0]?.id ?? null;
  const activeAccountId = selectedAccountId ?? defaultAccountId;

  // profile.amount_buttons, editable in Settings → Quick amounts — falls
  // back to the schema default if it's ever empty (e.g. mid-edit there).
  // These are always CZK shortcuts (the placeholder in Settings says so),
  // so they're hidden whenever a foreign currency is selected below —
  // adding "+50" to a PLN amount would silently mean something different
  // from what the button shows.
  const quickAmounts = amountButtons.length > 0 ? amountButtons : [20, 50, 100, 200];

  function shiftedDateISO(offset: number) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  }

  const transactionDateISO = useMemo(() => shiftedDateISO(dayOffset), [dayOffset]);

  const dateLabel = useMemo(() => {
    const short = formatShortDate(transactionDateISO, language);
    if (dayOffset === 0) return `${t('common.today')} (${short})`;
    if (dayOffset === 1) return `${t('common.tomorrow')} (${short})`;
    if (dayOffset === -1) return `${t('common.yesterday')} (${short})`;
    const n = dayOffset > 0 ? `+${dayOffset} ${t('common.days')}` : `${dayOffset} ${t('common.days')}`;
    return `${n} (${short})`;
  }, [dayOffset, transactionDateISO, language, t]);

  // Cycles CZK → each active currency → back to CZK (Pavel's answer: CZK
  // stays part of the cycle, one control does everything). Tapping the
  // small currency badge next to the amount calls this.
  function cycleCurrency() {
    const list = ['CZK', ...activeCurrencies];
    const idx = list.indexOf(currency);
    setCurrency(list[(idx + 1) % list.length]);
  }

  // Fetches (cache-first — see lib/exchange-rates.ts) the rate for the
  // selected currency/date whenever either changes, NOT on every keystroke
  // of the amount itself — the rate doesn't depend on how much was typed,
  // only on which currency and which day. A cache miss triggers a real
  // ČNB call in the background (via the fetch-exchange-rate Edge
  // Function) and gets stored for next time, per Pavel's "if this
  // particular day is not downloaded yet, it should be downloaded in
  // background and saved to the database."
  useEffect(() => {
    if (currency === 'CZK') {
      setRateInfo(null);
      setRateError(null);
      return;
    }
    let cancelled = false;
    setRateLoading(true);
    setRateError(null);
    ensureRate(currency, transactionDateISO).then(({ rate, error }) => {
      if (cancelled) return;
      setRateLoading(false);
      if (error) {
        setRateError(error);
        setRateInfo(null);
      } else {
        setRateInfo(rate);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [currency, transactionDateISO]);

  // Live CZK-equivalent preview shown next to the amount input — recomputes
  // on every keystroke from the already-fetched rate, no extra network call.
  const czkEquivalent = useMemo(() => {
    if (currency === 'CZK' || !rateInfo) return null;
    const numeric = Number(amount);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return toCzk(numeric, rateInfo);
  }, [currency, rateInfo, amount]);

  function linkForToken(token: string) {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      return `${window.location.origin}/d/${token}`;
    }
    return `/d/${token}`;
  }

  function triggerPhotoPicker() {
    fileInputRef.current?.click();
  }

  function clearPhoto() {
    setPhotoPath(null);
    setPhotoPreviewUrl(null);
    setPhotoError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handlePhotoChange(e: { target: { files: FileList | null } }) {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    setPhotoError(null);
    setPhotoUploading(true);
    const ext = file.name.includes('.') ? file.name.split('.').pop() : 'jpg';
    const path = `${user.id}/${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from('receipts').upload(path, file, {
      contentType: file.type || 'image/jpeg',
    });
    if (error) {
      setPhotoError(error.message);
      setPhotoUploading(false);
      return;
    }
    setPhotoPath(path);
    setPhotoPreviewUrl(URL.createObjectURL(file));
    setPhotoUploading(false);
  }

  // ── Split-people helpers (multi-person rebuild) ─────────────────────
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
  /** Divides splitTotalAmount evenly across the current people list —
   * re-pressable any time the total or the people list changes, since it's
   * a pure recompute from whatever's currently in those two, not something
   * that accumulates. */
  function handleSplitEvenly() {
    setSplitPeople((prev) => splitEvenly(splitTotalNumeric, prev));
  }
  function resetSplitState() {
    setSplitEnabled(false);
    setSplitTotalAmount('');
    setSplitMessage('');
    setSplitPeople([emptySplitPerson()]);
  }

  async function handleSave() {
    const numericAmount = Number(amount);
    if (!numericAmount || numericAmount <= 0) return;

    const isExpense = entryType === 'EXPENSE';
    if (!user || !activeAccountId || (isExpense && !activeCategoryId)) {
      setErrorMsg(t('home.settingUpAccount'));
      return;
    }

    // A foreign currency needs its rate resolved before there's a CZK
    // amount to save at all — ensureRate() already kicked off the fetch
    // as soon as the currency was picked (see the effect above), so this
    // is normally instant; it only blocks Save while that first fetch for
    // a brand-new date/currency pair is genuinely still in flight.
    if (currency !== 'CZK') {
      if (rateLoading) {
        setErrorMsg(t('home.rateFetching'));
        return;
      }
      if (rateError || !rateInfo) {
        setErrorMsg(`${t('home.rateErrorPrefix')} ${rateError ?? ''}`);
        return;
      }
    }
    const czkAmount = currency !== 'CZK' && rateInfo ? toCzk(numericAmount, rateInfo) : numericAmount;

    const validPeople = validSplitPeople(splitPeople);
    const splitting = isExpense && splitEnabled && validPeople.length > 0 && splitTotalNumeric > 0;
    if (splitting && splitTotalNumeric > czkAmount) {
      setErrorMsg(t('home.splitTooBig'));
      return;
    }
    if (splitting && splitSum > splitTotalNumeric + 0.01) {
      setErrorMsg(t('home.splitOverAllocatedError'));
      return;
    }

    setSaving(true);
    setErrorMsg(null);
    setShareLinks([]);

    const transactionDate = transactionDateISO;
    // month_start_day-aware — see lib/budget-month.ts. Defaults to plain
    // calendar months until Settings → Profile & preferences sets it.
    const budgetMonth = budgetMonthForDate(transactionDate, monthStartDay);

    const { data: transaction, error } = await supabase
      .from('transactions')
      .insert({
        owner_id: user.id,
        budget_month: budgetMonth,
        transaction_date: transactionDate,
        type: entryType,
        account_id: activeAccountId,
        // Income isn't categorized (no Categories UI creates INCOME-type
        // categories yet — build-roadmap-v1.md Phase 4) — category_id is
        // nullable on transactions for exactly this.
        category_id: isExpense ? activeCategoryId : null,
        amount: czkAmount,
        note: note.trim() || null,
        receipt_photo_url: photoPath,
        original_currency: currency !== 'CZK' ? currency : null,
        original_amount: currency !== 'CZK' ? numericAmount : null,
        exchange_rate: currency !== 'CZK' && rateInfo ? rateInfo.rate / rateInfo.amountUnit : null,
      })
      .select('id')
      .single();

    if (error || !transaction) {
      setErrorMsg(error?.message ?? t('common.savingError'));
      setSaving(false);
      return;
    }

    if (splitting) {
      // Created one by one (see lib/split-people.ts) — the expense itself
      // is already saved either way, so a partial failure here surfaces an
      // error without rolling anything back.
      const { links, error: splitError } = await createDebtsForSplit({
        ownerId: user.id,
        transactionId: transaction.id,
        targetAccountId: activeAccountId,
        message: splitMessage.trim() || null,
        people: validPeople,
      });
      if (splitError) setErrorMsg(`${t('common.shareLinkFailedPrefix')} ${splitError}`);
      setShareLinks(links.map((l) => ({ name: l.name, link: linkForToken(l.token) })));
    }

    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1200);
    setEntryType('EXPENSE');
    setAmount('');
    setNote('');
    setCurrency('CZK');
    resetSplitState();
    setCopiedLinkIdx(null);
    setSelectedAccountId(null);
    clearPhoto();
    setSaving(false);
  }

  async function copyShareLink(idx: number) {
    const link = shareLinks[idx];
    if (!link) return;
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(link.link);
      setCopiedLinkIdx(idx);
      setTimeout(() => setCopiedLinkIdx(null), 1500);
    }
  }

  return (
    <View style={[styles.container, variant === 'desktop' && styles.containerDesktop]}>
      <View style={[styles.typeToggle, { backgroundColor: tokens.card }]}>
        {(['EXPENSE', 'INCOME'] as const).map((type) => {
          const active = entryType === type;
          return (
            <Pressable
              key={type}
              onPress={() => setEntryType(type)}
              style={[styles.typeToggleBtn, { backgroundColor: active ? tokens.accent : 'transparent' }]}
            >
              <Text
                style={{
                  color: active ? tokens.accentText : tokens.textMuted,
                  fontFamily: fontFamily.semibold,
                  fontSize: 13,
                }}
              >
                {type === 'EXPENSE' ? t('home.entryTypeExpense') : t('home.entryTypeIncome')}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.dateRow}>
        <Pressable
          onPress={() => setDayOffset((d) => d - 1)}
          style={[styles.dateShiftBtn, { backgroundColor: tokens.card }]}
        >
          <Text style={{ color: tokens.text, fontFamily: fontFamily.bold }}>−</Text>
        </Pressable>
        <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, minWidth: 130, textAlign: 'center' }}>
          {dateLabel}
        </Text>
        <Pressable
          onPress={() => setDayOffset((d) => d + 1)}
          style={[styles.dateShiftBtn, { backgroundColor: tokens.card }]}
        >
          <Text style={{ color: tokens.text, fontFamily: fontFamily.bold }}>+</Text>
        </Pressable>
      </View>

      <View style={styles.amountRow}>
        <TextInput
          value={amount}
          onChangeText={setAmount}
          keyboardType="numeric"
          placeholder="0"
          placeholderTextColor={tokens.textMuted}
          style={[styles.amountInput, { color: tokens.text }]}
        />
        {/* Tap cycles CZK → each active currency → back to CZK (Pavel's
            answer: CZK is part of the cycle, one control does everything).
            Only shown once there's something to cycle through. */}
        {activeCurrencies.length > 0 && (
          <Pressable
            onPress={cycleCurrency}
            style={[styles.currencyBadge, { backgroundColor: tokens.card, borderColor: tokens.border }]}
          >
            <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 13 }}>{currency}</Text>
          </Pressable>
        )}
      </View>

      {currency !== 'CZK' && (
        <Text style={[styles.czkEquivalent, { color: tokens.textMuted }]}>
          {rateLoading
            ? t('home.rateFetching')
            : rateError
            ? `${t('home.rateErrorPrefix')} ${rateError}`
            : czkEquivalent !== null
            ? `≈ ${czkEquivalent} ${t('common.czk')}`
            : ' '}
        </Text>
      )}

      {currency === 'CZK' && (
        <View style={styles.chipRow}>
          {quickAmounts.map((v) => (
            <Pressable
              key={v}
              onPress={() => setAmount((prev) => String((Number(prev) || 0) + v))}
              style={[styles.chip, { backgroundColor: tokens.card }]}
            >
              <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13 }}>
                {v >= 0 ? `+${v}` : `−${Math.abs(v)}`}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {entryType === 'EXPENSE' && (
        <View style={styles.chipRow}>
          {categories.length === 0 ? (
            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13 }}>
              {dataLoading ? t('home.settingUpCategories') : t('home.noCategoriesYet')}
            </Text>
          ) : (
            categories.map((cat) => {
              const active = activeCategoryId === cat.id;
              return (
                <Pressable
                  key={cat.id}
                  onPress={() => setCategoryId(cat.id)}
                  style={[styles.chip, { backgroundColor: active ? tokens.accent : tokens.card }]}
                >
                  <Text
                    style={{
                      color: active ? tokens.accentText : tokens.text,
                      fontFamily: fontFamily.semibold,
                      fontSize: 13,
                    }}
                  >
                    {cat.name}
                  </Text>
                </Pressable>
              );
            })
          )}
        </View>
      )}

      <TextInput
        value={note}
        onChangeText={setNote}
        placeholder={t('home.notePlaceholder')}
        placeholderTextColor={tokens.textMuted}
        style={[styles.noteInput, { color: tokens.text, borderColor: tokens.border }]}
      />

      <Pressable onPress={() => setShowMoreOptions((v) => !v)} style={styles.splitToggle}>
        <Text style={{ color: tokens.accent, fontFamily: fontFamily.semibold, fontSize: 13 }}>
          {showMoreOptions ? t('home.moreOptionsHide') : t('home.moreOptionsShow')}
        </Text>
      </Pressable>

      {showMoreOptions && (
        <View style={[styles.splitPanel, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginBottom: 6 }}>
            {t('home.accountLabel')}
          </Text>
          <View style={styles.chipRow}>
            {accounts.map((acc) => {
              const active = activeAccountId === acc.id;
              return (
                <Pressable
                  key={acc.id}
                  onPress={() => setSelectedAccountId(acc.id)}
                  style={[styles.chip, { backgroundColor: active ? tokens.accent : tokens.cardAlt }]}
                >
                  <Text
                    style={{
                      color: active ? tokens.accentText : tokens.text,
                      fontFamily: fontFamily.semibold,
                      fontSize: 12.5,
                    }}
                  >
                    {acc.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text
            style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 12, marginBottom: 6 }}
          >
            {t('home.receiptPhotoLabel')}
          </Text>
          {Platform.OS === 'web' ? (
            <>
              {photoPreviewUrl ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Image source={{ uri: photoPreviewUrl }} style={styles.photoPreview} />
                  <Pressable onPress={clearPhoto}>
                    <Text style={{ color: tokens.coral, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                      {t('common.delete')}
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  onPress={triggerPhotoPicker}
                  disabled={photoUploading}
                  style={[styles.photoBtn, { backgroundColor: tokens.cardAlt, opacity: photoUploading ? 0.6 : 1 }]}
                >
                  <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                    {photoUploading ? t('common.saving') : t('home.addPhoto')}
                  </Text>
                </Pressable>
              )}
              {photoError && (
                <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 6 }}>
                  {photoError}
                </Text>
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
            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5 }}>
              {t('home.photoWebOnly')}
            </Text>
          )}
        </View>
      )}

      {entryType === 'EXPENSE' && (
        <Pressable onPress={() => setSplitEnabled((v) => !v)} style={styles.splitToggle}>
          <Text style={{ color: tokens.accent, fontFamily: fontFamily.semibold, fontSize: 13 }}>
            {splitEnabled ? t('home.splitToggleOff') : t('home.splitToggleOn')}
          </Text>
        </Pressable>
      )}

      {entryType === 'EXPENSE' && splitEnabled && (
        <View style={[styles.splitPanel, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
          {/* Amount + message stay on top (Pavel's request) — the people
              list is at the end, below the evenly-split control. */}
          <TextInput
            value={splitTotalAmount}
            onChangeText={setSplitTotalAmount}
            keyboardType="numeric"
            placeholder={t('home.splitTotalPlaceholder')}
            placeholderTextColor={tokens.textMuted}
            style={[styles.splitInput, { color: tokens.text, borderColor: tokens.border }]}
          />
          <TextInput
            value={splitMessage}
            onChangeText={setSplitMessage}
            placeholder={t('home.messagePlaceholder')}
            placeholderTextColor={tokens.textMuted}
            style={[styles.splitInput, { color: tokens.text, borderColor: tokens.border }]}
          />

          <View style={styles.splitEvenlyRow}>
            <Pressable
              onPress={handleSplitEvenly}
              disabled={splitTotalNumeric <= 0}
              style={[styles.splitAddPersonBtn, { backgroundColor: tokens.cardAlt, opacity: splitTotalNumeric > 0 ? 1 : 0.5 }]}
            >
              <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                {t('home.splitEvenlyBtn')}
              </Text>
            </Pressable>
            <Text
              style={{
                color: splitRemaining === 0 ? tokens.greenFg : splitRemaining < 0 ? tokens.coral : tokens.textMuted,
                fontFamily: fontFamily.semibold,
                fontSize: 12.5,
              }}
            >
              {splitSum} / {splitTotalNumeric || 0} {t('common.czk')}
              {splitRemaining > 0 ? ` · ${t('home.splitStillMissing')} ${splitRemaining}` : ''}
              {splitRemaining < 0 ? ` · ${t('home.splitOverAllocated')} ${Math.abs(splitRemaining)}` : ''}
            </Text>
          </View>

          {splitPeople.map((p) => (
            <View key={p.id} style={styles.splitPersonRow}>
              <TextInput
                value={p.name}
                onChangeText={(v) => updateSplitPerson(p.id, 'name', v)}
                placeholder={t('home.whoOwesPlaceholder')}
                placeholderTextColor={tokens.textMuted}
                style={[styles.splitInput, { color: tokens.text, borderColor: tokens.border, flex: 2 }]}
              />
              <TextInput
                value={p.amount}
                onChangeText={(v) => updateSplitPerson(p.id, 'amount', v)}
                keyboardType="numeric"
                placeholder={t('home.howMuchPlaceholder')}
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
          <Pressable onPress={addSplitPerson} style={[styles.splitAddPersonBtn, { backgroundColor: tokens.cardAlt }]}>
            <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
              {t('home.addPersonBtn')}
            </Text>
          </Pressable>

          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5 }}>
            {t('home.splitHint')}
          </Text>
        </View>
      )}

      {errorMsg && (
        <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 13, textAlign: 'center' }}>
          {errorMsg}
        </Text>
      )}

      {shareLinks.length > 0 && (
        <View style={[styles.shareBox, { backgroundColor: tokens.greenBg }]}>
          <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
            {t('home.shareLinkCreated')}
          </Text>
          {shareLinks.map((link, idx) => (
            <View key={link.link} style={styles.shareLinkRow}>
              <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.semibold, fontSize: 12 }}>{link.name}</Text>
              <Text
                selectable
                numberOfLines={1}
                style={{ color: tokens.greenFg, fontFamily: fontFamily.medium, fontSize: 12 }}
              >
                {link.link}
              </Text>
              <Pressable onPress={() => copyShareLink(idx)} style={[styles.copyBtn, { backgroundColor: tokens.card }]}>
                <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12 }}>
                  {copiedLinkIdx === idx ? t('common.copied') : t('common.copyLink')}
                </Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      <Pressable
        onPress={handleSave}
        disabled={saving || dataLoading || photoUploading}
        style={[styles.saveBtn, { backgroundColor: tokens.accent, opacity: saving || dataLoading || photoUploading ? 0.6 : 1 }]}
      >
        <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 15 }}>
          {savedFlash ? t('home.savedBtn') : t('home.saveBtn')}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { width: '100%', maxWidth: 390, gap: 16 },
  containerDesktop: { maxWidth: 460 },
  typeToggle: { flexDirection: 'row', borderRadius: 12, padding: 3, alignSelf: 'center' },
  typeToggleBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 9 },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'center' },
  dateShiftBtn: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  amountRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  amountInput: { flex: 1, fontSize: 48, fontFamily: fontFamily.regular, textAlign: 'center' },
  currencyBadge: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1 },
  czkEquivalent: { textAlign: 'center', fontSize: 13, fontFamily: fontFamily.medium, marginTop: -8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 12 },
  noteInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  splitToggle: { alignItems: 'center', paddingVertical: 2 },
  splitPanel: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 8 },
  splitInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  splitPersonRow: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  splitEvenlyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  splitAddPersonBtn: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9 },
  shareBox: { borderRadius: 14, padding: 12, gap: 8 },
  shareLinkRow: { gap: 4 },
  copyBtn: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9 },
  saveBtn: { paddingVertical: 16, borderRadius: 14, alignItems: 'center' },
  photoBtn: { alignSelf: 'flex-start', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10 },
  photoPreview: { width: 44, height: 44, borderRadius: 8 },
});
