import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, TextStyle, View, ViewStyle } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { useLanguage } from '@/lib/language-context';

/**
 * Name field for a split-person row (components/ExpenseEntryForm.tsx and
 * app/(app)/transactions.tsx) that proposes matches from Pavel's own debt
 * history as he types — his spec: typing "Ma" should be able to surface
 * "already existing or past debts: Maty" so he can tap it instead of
 * re-typing (and, critically, instead of typing a slightly different
 * spelling that would otherwise fragment one person across several debts
 * — see lib/split-people.ts's usePastDebtorNames doc comment).
 */
export function NameAutocompleteInput({
  value,
  onChangeText,
  pastNames,
  placeholder,
  containerStyle,
  inputStyle,
  maxSuggestions = 5,
}: {
  value: string;
  onChangeText: (v: string) => void;
  /** Full pool of past debtor names to match against — usually
   * usePastDebtorNames()'s return value, passed down so the query only
   * runs once per screen rather than once per split-person row. */
  pastNames: string[];
  placeholder?: string;
  containerStyle?: ViewStyle;
  inputStyle?: TextStyle | (TextStyle | undefined)[];
  maxSuggestions?: number;
}) {
  const { tokens } = useTheme();
  const { t } = useLanguage();
  const [focused, setFocused] = useState(false);

  const typed = value.trim().toLowerCase();
  const matches: string[] = [];
  if (focused && typed) {
    const seen = new Set<string>();
    // Prefix matches first (Pavel's own example: "Ma" -> "Maty"), then
    // fall back to substring matches ("close matches") only if there's
    // room left, so an exact prefix hit never gets crowded out.
    for (const name of pastNames) {
      const lower = name.toLowerCase();
      if (lower === typed || seen.has(lower)) continue;
      if (lower.startsWith(typed)) {
        matches.push(name);
        seen.add(lower);
        if (matches.length >= maxSuggestions) break;
      }
    }
    if (matches.length < maxSuggestions) {
      for (const name of pastNames) {
        const lower = name.toLowerCase();
        if (seen.has(lower) || lower === typed) continue;
        if (lower.includes(typed)) {
          matches.push(name);
          seen.add(lower);
          if (matches.length >= maxSuggestions) break;
        }
      }
    }
  }

  return (
    <View style={[styles.container, containerStyle]}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        // Delayed so a tap on a suggestion below registers before the
        // dropdown disappears out from under it.
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder={placeholder}
        placeholderTextColor={tokens.textMuted}
        style={inputStyle}
      />
      {matches.length > 0 && (
        <View style={[styles.dropdown, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
          <Text style={[styles.dropdownLabel, { color: tokens.textMuted }]}>{t('home.pastDebtsLabel')}</Text>
          {matches.map((name) => (
            <Pressable
              key={name}
              onPress={() => {
                onChangeText(name);
                setFocused(false);
              }}
              style={styles.dropdownItem}
            >
              <Text style={{ color: tokens.text, fontFamily: fontFamily.medium, fontSize: 13 }}>{name}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'relative' },
  dropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: 4,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 4,
    zIndex: 50,
    elevation: 6,
  },
  dropdownLabel: {
    fontFamily: fontFamily.medium,
    fontSize: 10.5,
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 2,
  },
  dropdownItem: { paddingHorizontal: 12, paddingVertical: 8 },
});
