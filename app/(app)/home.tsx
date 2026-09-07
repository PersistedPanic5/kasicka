import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { useLanguage } from '@/lib/language-context';
import { ExpenseEntryForm } from '@/components/ExpenseEntryForm';

export default function DesktopHome() {
  const { tokens } = useTheme();
  const { t } = useLanguage();
  return (
    <View style={styles.wrap}>
      <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 24, marginBottom: 20 }}>
        {t('home.title')}
      </Text>
      <ExpenseEntryForm variant="desktop" />
    </View>
  );
}

const styles = StyleSheet.create({
  // Was 'flex-start' — with no width cap anywhere above this, the card sat
  // pinned to the top-left corner on a wide desktop window instead of
  // reading as a centered page (Pavel's report). (app)/_layout.tsx now caps
  // the whole content column's width; centering here places the card in
  // the middle of that column instead of hugging its left edge.
  wrap: { flex: 1, alignItems: 'center' },
});
