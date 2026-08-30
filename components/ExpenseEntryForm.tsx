import { createElement, useMemo, useRef, useState } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth-context';
import { useAppData } from '@/lib/use-app-data';
import { useLanguage } from '@/lib/language-context';

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
  const { t } = useLanguage();
  const { user } = useAuth();
  const { defaultAccountId, categories, accounts, loading: dataLoading } = useAppData();

  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [dayOffset, setDayOffset] = useState(0);
  const [note, setNote] = useState('');
  const [splitEnabled, setSplitEnabled] = useState(false);
  const [splitName, setSplitName] = useState('');
  const [splitAmount, setSplitAmount] = useState('');
  const [splitMessage, setSplitMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

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

  const quickAmounts = [20, 50, 100, 200]; // TODO: profile.amount_buttons (More → Profile)

  const dateLabel = useMemo(() => {
    if (dayOffset === 0) return t('common.today');
    if (dayOffset === 1) return t('common.tomorrow');
    if (dayOffset === -1) return t('common.yesterday');
    return dayOffset > 0 ? `+${dayOffset} ${t('common.days')}` : `${dayOffset} ${t('common.days')}`;
  }, [dayOffset, t]);

  function shiftedDateISO(offset: number) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  }

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

  async function handleSave() {
    const numericAmount = Number(amount);
    if (!numericAmount || numericAmount <= 0) return;

    if (!user || !activeAccountId || !activeCategoryId) {
      setErrorMsg(t('home.settingUpAccount'));
      return;
    }

    const numericSplit = Number(splitAmount);
    const splitting = splitEnabled && splitName.trim().length > 0 && numericSplit > 0;
    if (splitEnabled && splitting && numericSplit > numericAmount) {
      setErrorMsg(t('home.splitTooBig'));
      return;
    }

    setSaving(true);
    setErrorMsg(null);
    setShareLink(null);

    const transactionDate = shiftedDateISO(dayOffset);
    // No month_start_day-aware budget cycle yet (that's the Monthly Wizard,
    // Phase 3) — calendar month is the right default until then.
    const budgetMonth = `${transactionDate.slice(0, 7)}-01`;

    const { data: transaction, error } = await supabase
      .from('transactions')
      .insert({
        owner_id: user.id,
        budget_month: budgetMonth,
        transaction_date: transactionDate,
        type: 'EXPENSE',
        account_id: activeAccountId,
        category_id: activeCategoryId,
        amount: numericAmount,
        note: note.trim() || null,
        receipt_photo_url: photoPath,
      })
      .select('id')
      .single();

    if (error || !transaction) {
      setErrorMsg(error?.message ?? t('common.savingError'));
      setSaving(false);
      return;
    }

    if (splitting) {
      const { data: debt, error: debtError } = await supabase
        .from('debts')
        .insert({
          owner_id: user.id,
          transaction_id: transaction.id,
          owed_by_name: splitName.trim(),
          amount: numericSplit,
          target_account_id: activeAccountId,
          message: splitMessage.trim() || null,
        })
        .select('share_token')
        .single();

      if (debtError) {
        // The expense itself is already saved — a failed debt link isn't
        // worth losing that, so surface it but don't roll anything back.
        setErrorMsg(`${t('common.shareLinkFailedPrefix')} ${debtError.message}`);
      } else if (debt) {
        setShareLink(linkForToken(debt.share_token));
      }
    }

    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1200);
    setAmount('');
    setNote('');
    setSplitEnabled(false);
    setSplitName('');
    setSplitAmount('');
    setSplitMessage('');
    setLinkCopied(false);
    setSelectedAccountId(null);
    clearPhoto();
    setSaving(false);
  }

  async function copyShareLink() {
    if (!shareLink) return;
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(shareLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1500);
    }
  }

  return (
    <View style={[styles.container, variant === 'desktop' && styles.containerDesktop]}>
      <View style={styles.dateRow}>
        <Pressable
          onPress={() => setDayOffset((d) => d - 1)}
          style={[styles.dateShiftBtn, { backgroundColor: tokens.card }]}
        >
          <Text style={{ color: tokens.text, fontFamily: fontFamily.bold }}>−</Text>
        </Pressable>
        <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, width: 90, textAlign: 'center' }}>
          {dateLabel}
        </Text>
        <Pressable
          onPress={() => setDayOffset((d) => d + 1)}
          style={[styles.dateShiftBtn, { backgroundColor: tokens.card }]}
        >
          <Text style={{ color: tokens.text, fontFamily: fontFamily.bold }}>+</Text>
        </Pressable>
      </View>

      <TextInput
        value={amount}
        onChangeText={setAmount}
        keyboardType="numeric"
        placeholder="0"
        placeholderTextColor={tokens.textMuted}
        style={[styles.amountInput, { color: tokens.text }]}
      />

      <View style={styles.chipRow}>
        {quickAmounts.map((v) => (
          <Pressable
            key={v}
            onPress={() => setAmount((prev) => String((Number(prev) || 0) + v))}
            style={[styles.chip, { backgroundColor: tokens.card }]}
          >
            <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13 }}>+{v}</Text>
          </Pressable>
        ))}
      </View>

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

      <Pressable onPress={() => setSplitEnabled((v) => !v)} style={styles.splitToggle}>
        <Text style={{ color: tokens.accent, fontFamily: fontFamily.semibold, fontSize: 13 }}>
          {splitEnabled ? t('home.splitToggleOff') : t('home.splitToggleOn')}
        </Text>
      </Pressable>

      {splitEnabled && (
        <View style={[styles.splitPanel, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
          <TextInput
            value={splitName}
            onChangeText={setSplitName}
            placeholder={t('home.whoOwesPlaceholder')}
            placeholderTextColor={tokens.textMuted}
            style={[styles.splitInput, { color: tokens.text, borderColor: tokens.border }]}
          />
          <TextInput
            value={splitAmount}
            onChangeText={setSplitAmount}
            keyboardType="numeric"
            placeholder={t('home.howMuchPlaceholder')}
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

      {shareLink && (
        <View style={[styles.shareBox, { backgroundColor: tokens.greenBg }]}>
          <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.semibold, fontSize: 12.5, marginBottom: 6 }}>
            {t('home.shareLinkCreated')}
          </Text>
          <Text
            selectable
            numberOfLines={1}
            style={{ color: tokens.greenFg, fontFamily: fontFamily.medium, fontSize: 12, marginBottom: 8 }}
          >
            {shareLink}
          </Text>
          <Pressable onPress={copyShareLink} style={[styles.copyBtn, { backgroundColor: tokens.card }]}>
            <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12 }}>
              {linkCopied ? t('common.copied') : t('common.copyLink')}
            </Text>
          </Pressable>
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
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'center' },
  dateShiftBtn: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  amountInput: { fontSize: 48, fontFamily: fontFamily.regular, textAlign: 'center' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 12 },
  noteInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  splitToggle: { alignItems: 'center', paddingVertical: 2 },
  splitPanel: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 8 },
  splitInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  shareBox: { borderRadius: 14, padding: 12 },
  copyBtn: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9 },
  saveBtn: { paddingVertical: 16, borderRadius: 14, alignItems: 'center' },
  photoBtn: { alignSelf: 'flex-start', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10 },
  photoPreview: { width: 44, height: 44, borderRadius: 8 },
});
