import { Pressable, StyleSheet } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme } from '@/lib/theme-context';

/**
 * The working light/dark toggle every mockup shows in its header.
 * Sun/moon glyphs drawn as inline SVG paths (matching the mockups —
 * no icon font or emoji dependency).
 */
export function ThemeToggle({ size = 36 }: { size?: number }) {
  const { mode, tokens, toggle } = useTheme();
  return (
    <Pressable
      onPress={toggle}
      style={[
        styles.button,
        { width: size, height: size, backgroundColor: tokens.card, borderColor: tokens.border },
      ]}
      accessibilityRole="button"
      accessibilityLabel={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {mode === 'dark' ? (
        <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={tokens.accent} strokeWidth={1.8} strokeLinecap="round">
          <Circle cx={12} cy={12} r={4} />
          <Path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </Svg>
      ) : (
        <Svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={tokens.textMuted} strokeWidth={1.8} strokeLinecap="round">
          <Path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" />
        </Svg>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    borderRadius: 11,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
