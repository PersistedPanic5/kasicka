import { Platform, useWindowDimensions } from 'react-native';
import { Redirect } from 'expo-router';

// Matches screens-and-flows.md: native installs always land on the fast
// mobile capture screen; on the web, a wide viewport (desktop/laptop) gets
// the full admin experience, a narrow one (phone browser / the installed
// PWA) gets the same fast-entry screen. 900px is a practical laptop-vs-phone
// cutoff — revisit once this is tested on real devices in Phase 1.
const DESKTOP_BREAKPOINT = 900;

export default function Index() {
  const { width } = useWindowDimensions();
  const isDesktop = Platform.OS === 'web' && width >= DESKTOP_BREAKPOINT;
  return <Redirect href={isDesktop ? '/(app)/home' : '/(mobile)'} />;
}
