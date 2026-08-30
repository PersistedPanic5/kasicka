import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { useAuth } from '@/lib/auth-context';
import { useLanguage } from '@/lib/language-context';

/**
 * The only screen a signed-out visitor can reach besides the public
 * /d/[token] debt-share page (see components/AuthGate.tsx). Single-user
 * app, Google only — architecture-v1.md "Auth".
 */
export default function SignIn() {
  const { tokens } = useTheme();
  const { signInWithGoogle } = useAuth();
  const { t } = useLanguage();

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: tokens.bg }]}>
      <View style={styles.content}>
        <Text
          style={{
            color: tokens.accent,
            fontFamily: fontFamily.extrabold,
            fontSize: 14,
            letterSpacing: 1,
            marginBottom: 10,
          }}
        >
          KASIČKA
        </Text>
        <Text
          style={{
            color: tokens.text,
            fontFamily: fontFamily.bold,
            fontSize: 22,
            marginBottom: 32,
            textAlign: 'center',
          }}
        >
          {t('signIn.title')}
        </Text>
        <Pressable onPress={signInWithGoogle} style={[styles.button, { backgroundColor: tokens.accent }]}>
          <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 15 }}>
            {t('signIn.continueWithGoogle')}
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  button: { paddingHorizontal: 28, paddingVertical: 16, borderRadius: 14 },
});
