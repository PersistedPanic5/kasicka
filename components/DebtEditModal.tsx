import { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { useLanguage } from '@/lib/language-context';
import { supabase } from '@/lib/supabase';
import { amountPatch, DEBT_EDIT_COLUMNS, type EditableDebt } from '@/lib/debt-bill';
import { DebtExtrasEditor, DetailsFields } from '@/components/DebtExtras';

/**
 * THE edit dialog for one debt — used by the Debts page and by the
 * transaction editor ("edit the split"). Name, amount, message, details,
 * reciprocated expenses, attachments. For a bill with details it also edits
 * every debt inside the bill; the bill's total is recalculated by the
 * database (migration 0021). Callers only open it for unpaid debts.
 */
export function DebtEditModal({
  debt,
  onClose,
  onChanged,
}: {
  debt: EditableDebt | null;
  onClose: () => void;
  /** something was saved — refresh whatever list is behind this dialog */
  onChanged: () => void;
}) {
  if (!debt) return null;
  return <Body key={debt.id} initial={debt} onClose={onClose} onChanged={onChanged} />;
}

function Body({ initial, onClose, onChanged }: { initial: EditableDebt; onClose: () => void; onChanged: () => void }) {
  const { tokens } = useTheme();
  const { t } = useLanguage();
  const [cur, setCur] = useState(initial);
  const [name, setName] = useState(initial.owed_by_name);
  const [amount, setAmount] = useState(String(initial.base_amount ?? initial.amount));
  const [message, setMessage] = useState(initial.message ?? '');
  const [details, setDetails] = useState(initial.details ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kids, setKids] = useState<EditableDebt[]>([]);
  const [groupMode, setGroupMode] = useState<string | null>(null);

  const loadKids = useCallback(async () => {
    if (!initial.breakdown) return;
    const { data } = await supabase
      .from('debts')
      .select(DEBT_EDIT_COLUMNS)
      .eq('merged_into_token', initial.share_token)
      .eq('status', 'MERGED')
      .order('created_at');
    setKids((data ?? []) as EditableDebt[]);
  }, [initial.breakdown, initial.share_token]);

  useEffect(() => {
    loadKids();
    if (initial.group_id) {
      supabase.from('debt_groups').select('mode').eq('id', initial.group_id).maybeSingle().then(({ data }) => setGroupMode(data?.mode ?? null));
    }
  }, [loadKids, initial.group_id]);

  /** After anything changed underneath (offset added, an included debt saved): re-read this debt's numbers. */
  async function refresh() {
    const { data } = await supabase.from('debts').select(DEBT_EDIT_COLUMNS).eq('id', initial.id).single();
    if (data) {
      setCur(data as EditableDebt);
      if (!initial.breakdown) setAmount(String(data.base_amount ?? data.amount));
    }
    await loadKids();
    onChanged();
  }

  async function save() {
    const patch: Record<string, unknown> = { owed_by_name: name.trim(), message: message.trim() || null, details: details.trim() || null };
    if (!name.trim()) return setError(t('debts.nameError'));
    if (!initial.breakdown && !(groupMode === 'ONE_QR')) {
      const p = amountPatch(cur, Number(amount.replace(',', '.')));
      if (!p) return setError(Number(amount) > 0 ? t('bill.offsetTooBig') : t('debts.amountError'));
      Object.assign(patch, p);
    }
    setSaving(true);
    setError(null);
    const { error: err } = await supabase.from('debts').update(patch).eq('id', initial.id);
    if (!err && initial.breakdown && name.trim() !== initial.owed_by_name) {
      // the person's name is the identity of their link — keep the included debts in step
      await supabase.from('debts').update({ owed_by_name: name.trim() }).eq('merged_into_token', initial.share_token);
    }
    setSaving(false);
    if (err) return setError(err.message);
    onChanged();
    onClose();
  }

  const label = (text: string, top = 12) => (
    <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginTop: top, marginBottom: 6 }}>{text}</Text>
  );
  const input = [s.input, { color: tokens.text, borderColor: tokens.border }];

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.overlay}>
        <View style={[s.card, { backgroundColor: tokens.bg, borderColor: tokens.border }]}>
          <ScrollView>
            <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 16, marginBottom: 6 }}>
              {initial.breakdown ? t('bill.editBillTitle') : t('debts.editTitle')}
            </Text>
            {initial.breakdown && (
              <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginBottom: 6 }}>{t('bill.explain')}</Text>
            )}

            {label(t('debts.whoOwesLabel'), 8)}
            <TextInput value={name} onChangeText={setName} style={input} />

            {initial.breakdown ? (
              <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 14, marginTop: 12 }}>
                {t('bill.total')}: {cur.amount} {t('common.czk')}
                <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12 }}>{`\n${t('bill.totalCalculated')}`}</Text>
              </Text>
            ) : (
              <>
                {label(cur.base_amount != null ? `${t('bill.original')} (${t('common.czk')})` : t('debts.amountLabel'))}
                <TextInput
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="numeric"
                  editable={groupMode !== 'ONE_QR'}
                  style={[...input, groupMode === 'ONE_QR' && { opacity: 0.5 }]}
                />
                {groupMode === 'ONE_QR' && (
                  <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginTop: 6 }}>{t('bill.groupAmountLocked')}</Text>
                )}
                {cur.base_amount != null && (
                  <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginTop: 6 }}>
                    {t('bill.toPay')}: {cur.amount} {t('common.czk')}
                  </Text>
                )}
              </>
            )}

            {label(t('debts.messageLabel'))}
            <TextInput
              value={message}
              onChangeText={setMessage}
              placeholder={t('common.optional')}
              placeholderTextColor={tokens.textMuted}
              style={input}
            />

            <View style={{ marginTop: 12 }}>
              <DetailsFields details={details} onDetails={setDetails} />
            </View>

            <DebtExtrasEditor debtId={initial.id} transactionId={initial.transaction_id} hideReceipt={initial.hide_receipt} onChanged={refresh} />

            {initial.breakdown && (
              <View style={{ marginTop: 18, gap: 10 }}>
                <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 14 }}>{t('bill.includedTitle')}</Text>
                {kids.map((k) => (
                  <ChildEditor key={k.id} child={k} onChanged={refresh} />
                ))}
              </View>
            )}

            {error && <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 12.5, marginTop: 12 }}>{error}</Text>}

            <View style={s.actions}>
              <Pressable onPress={onClose} style={[s.btn, { backgroundColor: tokens.card }]}>
                <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>{t('common.cancel')}</Text>
              </Pressable>
              <Pressable onPress={save} disabled={saving} style={[s.btn, { backgroundColor: tokens.accent, opacity: saving ? 0.6 : 1 }]}>
                <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 14 }}>{saving ? t('common.saving') : t('common.save')}</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/** One debt inside a bill: short name, original amount, details, reciprocated expenses, files — saved on its own. */
function ChildEditor({ child, onChanged }: { child: EditableDebt; onChanged: () => void }) {
  const { tokens } = useTheme();
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState(child.message ?? '');
  const [amount, setAmount] = useState(String(child.base_amount ?? child.amount));
  const [details, setDetails] = useState(child.details ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // numbers can change underneath (an offset was added) — follow them while the field is untouched
  useEffect(() => {
    setAmount(String(child.base_amount ?? child.amount));
  }, [child.base_amount, child.amount]);

  async function save() {
    const p = amountPatch(child, Number(amount.replace(',', '.')));
    if (!p) return setError(Number(amount) > 0 ? t('bill.offsetTooBig') : t('debts.amountError'));
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from('debts')
      .update({ ...p, message: message.trim() || null, details: details.trim() || null })
      .eq('id', child.id);
    setBusy(false);
    if (err) return setError(/cancel the whole debt/i.test(err.message) ? t('bill.offsetTooBig') : err.message);
    onChanged();
  }

  return (
    <View style={[s.child, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={s.childHead}>
        <Text numberOfLines={1} style={{ flex: 1, color: tokens.text, fontFamily: fontFamily.bold, fontSize: 13 }}>
          {child.message || t('bill.unnamed')}
        </Text>
        <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13, fontVariant: ['tabular-nums'] }}>
          {child.base_amount != null ? `${child.base_amount} → ${child.amount}` : child.amount} {t('common.czk')}
        </Text>
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.bold, fontSize: 14, width: 16, textAlign: 'center' }}>{open ? '−' : '+'}</Text>
      </Pressable>
      {open && (
        <View style={{ padding: 12, paddingTop: 0 }}>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginTop: 8, marginBottom: 6 }}>{t('bill.shortName')}</Text>
          <TextInput value={message} onChangeText={setMessage} style={[s.input, { color: tokens.text, borderColor: tokens.border }]} />
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginTop: 12, marginBottom: 6 }}>
            {child.base_amount != null ? `${t('bill.original')} (${t('common.czk')})` : t('debts.amountLabel')}
          </Text>
          <TextInput value={amount} onChangeText={setAmount} keyboardType="numeric" style={[s.input, { color: tokens.text, borderColor: tokens.border }]} />
          <View style={{ marginTop: 12 }}>
            <DetailsFields details={details} onDetails={setDetails} />
          </View>
          <DebtExtrasEditor debtId={child.id} transactionId={child.transaction_id} hideReceipt={child.hide_receipt} onChanged={onChanged} />
          {error && <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 12.5, marginTop: 10 }}>{error}</Text>}
          <Pressable onPress={save} disabled={busy} style={[s.btn, { backgroundColor: tokens.accent, marginTop: 14, flex: 0, opacity: busy ? 0.6 : 1 }]}>
            <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 13.5 }}>{t('bill.saveItem')}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { width: '100%', maxWidth: 440, maxHeight: '88%', borderRadius: 20, borderWidth: 1, padding: 20 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 20 },
  btn: { flex: 1, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, alignItems: 'center' },
  child: { borderWidth: 1, borderRadius: 14 },
  childHead: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 46, paddingHorizontal: 12 },
});
