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
  wrap: { flex: 1, alignItems: 'flex-start' },
});
