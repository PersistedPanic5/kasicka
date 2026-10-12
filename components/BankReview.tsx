import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { useLanguage } from '@/lib/language-context';
import { categoryColor } from '@/lib/identity';
import { dayLabel, formatKc } from '@/lib/bank';
import type { BankTransaction } from '@/types/database';

export type BankRow = Pick<
  BankTransaction,
  | 'id'
  | 'account_id'
  | 'booked_date'
  | 'amount'
  | 'merchant'
  | 'movement_type'
  | 'details'
  | 'kind'
  | 'suggested_category_id'
  | 'suggested_uses'
  | 'suggested_account_id'
  | 'recurring_item_id'
  | 'match_transaction_id'
  | 'status'
  | 'transaction_id'
  | 'to_account_id'
  | 'created_at'
>;

type Named = { id: string; name: string };

/** "Is this the one you entered?" — bottom sheet on a phone, centered card on desktop. */
export function MatchSheet({
  row,
  entry,
  busy,
  onYes,
  onNo,
}: {
  row: BankRow;
  entry: { transaction_date: string; note: string | null; amount: number; category: string | null } | null;
  busy: boolean;
  onYes: () => void;
  onNo: () => void;
}) {
  const { tokens } = useTheme();
  const { t } = useLanguage();
  return (
    <Modal transparent animationType="fade" onRequestClose={onNo}>
      <View style={s.dim}>
        <View style={[s.sheet, { backgroundColor: tokens.bg }]}>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 20 }}>{t('bank.matchTitle')}</Text>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 14, lineHeight: 20 }}>{t('bank.matchIntro')}</Text>

          <View style={[s.cmp, { backgroundColor: tokens.cardAlt, borderColor: tokens.border }]}>
            <Text style={[s.cmpLbl, { color: tokens.textMuted }]}>
              {t('bank.youEntered').replace('{date}', entry ? dayLabel(entry.transaction_date, t) : '')}
            </Text>
            <View style={s.cmpRow}>
              <Text style={[s.cmpName, { color: tokens.text }]} numberOfLines={1}>
                {[entry?.note, entry?.category].filter(Boolean).join(' · ') || '—'}
              </Text>
              <Text style={[s.cmpName, { color: tokens.text }]}>{entry ? formatKc(-entry.amount) : ''}</Text>
            </View>
          </View>
          <View style={[s.cmp, { backgroundColor: tokens.greenBg, borderColor: tokens.accentBorder }]}>
            <Text style={[s.cmpLbl, { color: tokens.greenFg }]}>{t('bank.fromBank').replace('{date}', dayLabel(row.booked_date, t))}</Text>
            <View style={s.cmpRow}>
              <Text style={[s.cmpName, { color: tokens.text }]} numberOfLines={1}>
                {row.details || row.merchant}
              </Text>
              <Text style={[s.cmpName, { color: tokens.text }]}>{formatKc(row.amount)}</Text>
            </View>
          </View>

          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13, lineHeight: 18 }}>{t('bank.matchHint')}</Text>

          <Pressable onPress={onYes} disabled={busy} style={[s.primary, { backgroundColor: tokens.accent, opacity: busy ? 0.6 : 1 }]}>
            <Text style={{ color: tokens.accentText, fontFamily: fontFamily.extrabold, fontSize: 16 }}>{t('bank.matchYes')}</Text>
          </Pressable>
          <Pressable onPress={onNo} disabled={busy} style={[s.secondary, { borderColor: tokens.border }]}>
            <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 15 }}>{t('bank.matchNo')}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const Icon = ({ d, color, extra }: { d: string; color: string; extra?: 'event' | 'person' | 'photo' }) => (
  <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <Path d={d} />
    {extra === 'event' && <Rect x="3" y="5" width="18" height="16" rx="2" />}
    {extra === 'person' && <Circle cx="9" cy="8" r="3.5" />}
    {extra === 'photo' && <Circle cx="12" cy="13" r="3.5" />}
  </Svg>
);
const ICON = {
  event: 'M3 10h18M8 3v4M16 3v4',
  split: 'M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6M17 5.5a3 3 0 010 5.5M21.5 20c0-2.5-1.5-4.4-3.5-5.3',
  note: 'M4 5h16M4 12h16M4 19h10',
  photo: 'M4 8h3l2-3h6l2 3h3v11H4z',
};

/** One payment at a time — the phone flow (Design: "Review one payment"). */
export function ReviewCard({
  row,
  index,
  total,
  categories,
  events,
  onSave,
  onSaveAndEdit,
  onOwnTransfer,
  onIgnore,
  onSkip,
  onBack,
}: {
  row: BankRow;
  index: number;
  total: number;
  categories: Named[];
  events: Named[];
  onSave: (categoryId: string | null, eventId: string | null, note: string) => Promise<void>;
  onSaveAndEdit: (categoryId: string | null, eventId: string | null, note: string, split: boolean) => Promise<void>;
  onOwnTransfer: () => void;
  onIgnore: () => void;
  onSkip: () => void;
  onBack: () => void;
}) {
  const { tokens } = useTheme();
  const { t } = useLanguage();
  const expense = row.amount < 0;
  const [categoryId, setCategoryId] = useState<string | null>(row.suggested_category_id);
  const [eventId, setEventId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [panel, setPanel] = useState<'event' | 'note' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = categories.find((c) => c.id === categoryId);
  const ready = !expense || !!categoryId;

  async function run(fn: () => Promise<void>) {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch {
      setError(t('bank.saveFailed'));
    }
    setBusy(false);
  }

  const tools: { key: 'event' | 'split' | 'note' | 'photo'; label: string; show: boolean }[] = [
    { key: 'event', label: t('bank.toolEvent'), show: events.length > 0 },
    { key: 'split', label: t('bank.toolSplit'), show: expense },
    { key: 'note', label: t('bank.toolNote'), show: true },
    { key: 'photo', label: t('bank.toolPhoto'), show: expense },
  ];

  return (
    <View style={s.screen}>
      <View style={s.topbar}>
        <Pressable onPress={onBack} accessibilityLabel={t('bank.back')} style={s.backBtn}>
          <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={tokens.text} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M15 18l-6-6 6-6" />
          </Svg>
        </Pressable>
        <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 16 }}>{t('bank.title')}</Text>
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.semibold, fontSize: 14, minWidth: 44, textAlign: 'right' }}>
          {t('bank.ofN').replace('{i}', String(index + 1)).replace('{n}', String(total))}
        </Text>
      </View>

      <View style={s.segs}>
        {Array.from({ length: total }, (_, i) => (
          <View key={i} style={[s.seg, { backgroundColor: i <= index ? tokens.accent : tokens.border }]} />
        ))}
      </View>

      <ScrollView contentContainerStyle={{ gap: 20, paddingBottom: 12 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={[s.card, { backgroundColor: tokens.card }]}>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.semibold, fontSize: 13 }}>
            {dayLabel(row.booked_date, t)}
            {row.movement_type ? ` · ${row.movement_type.toLowerCase().includes('kart') ? t('bank.card') : row.movement_type}` : ''}
          </Text>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 20, marginTop: 6 }}>{row.details || row.merchant}</Text>
          <Text style={{ color: expense ? tokens.text : tokens.greenFg, fontFamily: fontFamily.extrabold, fontSize: 46, letterSpacing: -1, marginTop: 4 }}>
            {formatKc(row.amount)}
          </Text>
        </View>

        {expense && (
          <View style={{ gap: 12 }}>
            <View style={s.rowBetween}>
              <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 15 }}>{t('bank.colCategory')}</Text>
              {!!row.suggested_uses && chosen && chosen.id === row.suggested_category_id && (
                <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.semibold, fontSize: 13 }}>
                  {t('bank.filedUnder').replace('{name}', chosen.name).replace('{n}', String(row.suggested_uses))}
                </Text>
              )}
            </View>
            <View style={s.chips}>
              {categories.map((c, i) => {
                const on = c.id === categoryId;
                return (
                  <Pressable
                    key={c.id}
                    onPress={() => setCategoryId(c.id)}
                    style={[s.chip, { borderColor: on ? tokens.accent : tokens.border, backgroundColor: on ? tokens.accent : tokens.cardAlt }]}
                  >
                    <View style={[s.dot, { backgroundColor: categoryColor(i, tokens) }]} />
                    <Text style={{ color: on ? tokens.accentText : tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>{c.name}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}

        <View style={s.tools}>
          {tools
            .filter((x) => x.show)
            .map((x) => {
              const active = (x.key === 'event' && (panel === 'event' || !!eventId)) || (x.key === 'note' && (panel === 'note' || !!note));
              return (
                <Pressable
                  key={x.key}
                  disabled={busy}
                  onPress={() => {
                    if (x.key === 'event') setPanel(panel === 'event' ? null : 'event');
                    else if (x.key === 'note') setPanel(panel === 'note' ? null : 'note');
                    else run(() => onSaveAndEdit(categoryId, eventId, note, x.key === 'split'));
                  }}
                  style={[s.tool, { borderColor: active ? tokens.accent : tokens.border, backgroundColor: active ? tokens.greenBg : 'transparent' }]}
                >
                  <Icon d={ICON[x.key]} color={tokens.text} extra={x.key === 'event' ? 'event' : x.key === 'split' ? 'person' : x.key === 'photo' ? 'photo' : undefined} />
                  <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 14 }}>{x.label}</Text>
                </Pressable>
              );
            })}
        </View>

        {panel === 'event' && (
          <View style={s.chips}>
            {[{ id: '', name: t('bank.noEvent') }, ...events].map((e) => {
              const on = (eventId ?? '') === e.id;
              return (
                <Pressable
                  key={e.id || 'none'}
                  onPress={() => setEventId(e.id || null)}
                  style={[s.chip, { borderColor: on ? tokens.accent : tokens.border, backgroundColor: on ? tokens.accent : tokens.cardAlt }]}
                >
                  <Text style={{ color: on ? tokens.accentText : tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>{e.name}</Text>
                </Pressable>
              );
            })}
          </View>
        )}
        {panel === 'note' && (
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder={t('bank.notePlaceholder')}
            placeholderTextColor={tokens.textMuted}
            style={[s.input, { borderColor: tokens.border, backgroundColor: tokens.cardAlt, color: tokens.text }]}
          />
        )}
        {error && <Text style={{ color: tokens.coral, fontFamily: fontFamily.semibold, fontSize: 13 }}>{error}</Text>}
      </ScrollView>

      <View style={{ gap: 10 }}>
        <Pressable
          onPress={() => run(() => onSave(categoryId, eventId, note))}
          disabled={!ready || busy}
          style={[s.primary, { backgroundColor: tokens.accent, opacity: ready && !busy ? 1 : 0.45 }]}
        >
          <Text style={{ color: tokens.accentText, fontFamily: fontFamily.extrabold, fontSize: 16 }}>
            {expense ? (chosen ? t('bank.saveTo').replace('{name}', chosen.name) : t('bank.chooseCategory')) : t('bank.addIncome')}
          </Text>
        </Pressable>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {[
            ...(expense ? [{ k: 'own', label: t('bank.ownTransfer'), fn: onOwnTransfer }] : []),
            { k: 'ign', label: t('bank.ignore'), fn: onIgnore },
            { k: 'skip', label: t('bank.skip'), fn: onSkip },
          ].map((b) => (
            <Pressable key={b.k} onPress={b.fn} disabled={busy} style={s.textBtn}>
              <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.bold, fontSize: 14 }}>{b.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, gap: 20, width: '100%', maxWidth: 480, alignSelf: 'center' },
  topbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 44 },
  backBtn: { width: 44, height: 44, marginLeft: -10, alignItems: 'center', justifyContent: 'center' },
  segs: { flexDirection: 'row', gap: 6 },
  seg: { flex: 1, height: 5, borderRadius: 3 },
  card: { borderRadius: 20, paddingHorizontal: 22, paddingTop: 22, paddingBottom: 24 },
  rowBetween: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { height: 44, borderRadius: 999, borderWidth: 1, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  tools: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tool: { flexGrow: 1, flexBasis: 80, height: 44, borderRadius: 12, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  input: { height: 48, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, fontFamily: fontFamily.semibold, fontSize: 15 },
  primary: { height: 54, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  secondary: { height: 48, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  textBtn: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center' },
  dim: { flex: 1, backgroundColor: 'rgba(28,26,21,0.45)', justifyContent: 'flex-end', alignItems: 'center' },
  sheet: { width: '100%', maxWidth: 520, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, paddingBottom: 28, gap: 14 },
  cmp: { borderRadius: 16, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14, gap: 4 },
  cmpLbl: { fontFamily: fontFamily.bold, fontSize: 13 },
  cmpRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 },
  cmpName: { fontFamily: fontFamily.extrabold, fontSize: 16, flexShrink: 1 },
});
