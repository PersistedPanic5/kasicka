import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { ExpenseEntryForm } from '@/components/ExpenseEntryForm';

export default function DesktopHome() {
  const { tokens } = useTheme();
  return (
    <View style={styles.wrap}>
      <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 24, marginBottom: 20 }}>
        Home
      </Text>
      <ExpenseEntryForm variant="desktop" />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'flex-start' },
});
