import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { useAuth } from '@/lib/auth-context';
import { PlaceholderScreen } from '@/components/PlaceholderScreen';

export default function More() {
  const { tokens } = useTheme();
  const { user, signOut } = useAuth();

  return (
    <View style={{ flex: 1 }}>
      <PlaceholderScreen
        title="More"
        phaseNote="Recurring items (Phase 2), Long-term & reserve (Phase 3), Categories & Accounts (Phase 1), and Profile & preferences — including the language switch and editable quick-amount buttons — arriving progressively as each phase needs them."
      />
      <View style={[styles.accountRow, { borderTopColor: tokens.border }]}>
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13 }}>
          Signed in as {user?.email ?? '…'}
        </Text>
        <Pressable onPress={signOut} style={[styles.signOutBtn, { backgroundColor: tokens.card }]}>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13 }}>Sign out</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 16,
    marginTop: 16,
    borderTopWidth: 1,
  },
  signOutBtn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10 },
});
