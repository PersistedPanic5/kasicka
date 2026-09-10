import { ScrollView, StyleSheet, Text, View } from 'react-native';
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
      {/* A ScrollView, not a plain View — on a shorter or narrower browser
          window (or a split-screen half) the form (especially with the
          split-with-someone panel open and a few people added) can grow
          taller than the space (app)/_layout.tsx's contentInner actually
          has, and a plain View has no scroll mechanism of its own, so the
          Save button ends up below the fold with no way to reach it
          (Pavel's report). Same fix as (mobile)/index.tsx's formScroll.
          showsVerticalScrollIndicator={false} keeps this looking like the
          rest of the card rather than growing a visible scrollbar down one
          side of it. */}
      <ScrollView style={styles.formScroll} showsVerticalScrollIndicator={false} contentContainerStyle={styles.formWrap}>
        <ExpenseEntryForm variant="desktop" />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  // Was 'flex-start' — with no width cap anywhere above this, the card sat
  // pinned to the top-left corner on a wide desktop window instead of
  // reading as a centered page (Pavel's report). (app)/_layout.tsx now caps
  // the whole content column's width; centering here places the card in
  // the middle of that column instead of hugging its left edge.
  wrap: { flex: 1, alignItems: 'center', width: '100%' },
  // flex: 1 + minHeight: 0 is what actually clamps this to the space `wrap`
  // has available (bounded, in turn, by (app)/_layout.tsx's contentInner)
  // instead of growing with the form — same fix as that file's comment.
  formScroll: { flex: 1, width: '100%', minHeight: 0 },
  formWrap: { alignItems: 'center', paddingBottom: 20 },
});
