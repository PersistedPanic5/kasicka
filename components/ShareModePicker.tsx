import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { useLanguage } from '@/lib/language-context';
import type { ShareMode } from '@/lib/debt-groups';

/** "How do they get the bill?" — shown in every split panel. */
export function ShareModePicker({ value, onChange }: { value: ShareMode; onChange: (m: ShareMode) => void }) {
  const { tokens } = useTheme();
  const { t } = useLanguage();
  const options: { id: ShareMode; label: string }[] = [
    { id: 'INDIVIDUAL', label: t('home.shareIndividual') },
    { id: 'ONE_QR', label: t('home.shareOneQr') },
    { id: 'PER_PERSON', label: t('home.sharePerPerson') },
  ];
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.semibold, fontSize: 12 }}>{t('home.shareModeTitle')}</Text>
      <View style={styles.row}>
        {options.map((o) => {
          const on = value === o.id;
          return (
            <Pressable
              key={o.id}
              onPress={() => onChange(o.id)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              style={[styles.opt, { borderColor: on ? tokens.accent : tokens.border, backgroundColor: on ? tokens.accent : tokens.cardAlt }]}
            >
              <Text style={{ color: on ? tokens.accentText : tokens.text, fontFamily: fontFamily.bold, fontSize: 12.5, textAlign: 'center' }}>
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, lineHeight: 16 }}>
        {t(value === 'ONE_QR' ? 'home.shareOneQrHint' : value === 'PER_PERSON' ? 'home.sharePerPersonHint' : 'home.shareIndividualHint')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  opt: { flexGrow: 1, flexBasis: 90, minHeight: 44, borderRadius: 10, borderWidth: 1, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
});
