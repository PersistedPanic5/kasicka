import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
} from '@expo-google-fonts/manrope';
import { ThemeProvider } from '@/lib/theme-context';

SplashScreen.preventAutoHideAsync().catch(() => {
  // no-op — fine on web / if already hidden
});

/**
 * Root layout for the whole app. Two very different faces live under here —
 * see screens-and-flows.md "Core UX principle": app/(mobile) is the
 * ultra-minimal fast-entry screen, app/(app) is the full desktop-style
 * admin experience (tabs), and app/d/[token] is the public, no-login debt
 * share page. app/index.tsx decides which of the first two a visitor lands
 * on; d/[token] is reachable directly regardless, since debt links get sent
 * to people who have never opened this app before.
 */
export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
  });

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync().catch(() => {});
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="(mobile)" />
          <Stack.Screen name="(app)" />
          <Stack.Screen name="d/[token]" />
        </Stack>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
