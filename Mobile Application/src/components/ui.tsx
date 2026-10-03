import React from 'react';
import {
  ActivityIndicator, Image, KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  type StyleProp, type TextInputProps, type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing, tones, type, type Tone } from '../theme';
import { initialsOf } from '../utils/format';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

export function Card({ children, style, onPress }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  if (onPress) {
    return (
      <Pressable onPress={onPress} android_ripple={{ color: colors.neutralSoft }} style={[styles.card, style]} accessibilityRole="button">
        {children}
      </Pressable>
    );
  }
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Button({
  label, onPress, variant = 'primary', loading, disabled, icon, style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  loading?: boolean;
  disabled?: boolean;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}) {
  const inactive = disabled || loading;
  const fg = variant === 'primary' || variant === 'danger' ? '#FFFFFF' : variant === 'ghost' ? colors.primary : colors.ink;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(inactive), busy: Boolean(loading) }}
      android_ripple={{ color: 'rgba(255,255,255,0.25)' }}
      style={[styles.button, styles[`button_${variant}`], inactive && styles.buttonDisabled, style]}
    >
      {loading ? <ActivityIndicator color={fg} /> : (
        <>
          {icon ? <Ionicons name={icon} size={18} color={fg} style={{ marginRight: spacing.sm }} /> : null}
          <Text style={[styles.buttonLabel, { color: fg }]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

export function Chip({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  return (
    <View style={[styles.chip, { backgroundColor: tones[tone].bg }]}>
      <Text style={[styles.chipLabel, { color: tones[tone].fg }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

export function Field({ label, error, hint, ...input }: TextInputProps & { label: string; error?: string; hint?: string }) {
  return (
    <View style={{ marginBottom: spacing.lg }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.muted}
        accessibilityLabel={label}
        {...input}
        style={[styles.input, input.multiline && styles.inputMultiline, error ? styles.inputError : null, input.style]}
      />
      {error ? <Text style={styles.fieldError}>{error}</Text> : hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

/** A tappable field that opens a picker (date, time, option sheet). */
export function PickerField({ label, value, placeholder, onPress, error, icon = 'chevron-down' }: {
  label: string; value?: string; placeholder?: string; onPress: () => void; error?: string; icon?: IconName;
}) {
  return (
    <View style={{ marginBottom: spacing.lg, flex: 1 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label}: ${value || placeholder || ''}`} style={[styles.input, styles.pickerField, error ? styles.inputError : null]}>
        <Text style={[type.body, !value && { color: colors.muted }]} numberOfLines={1}>{value || placeholder}</Text>
        <Ionicons name={icon} size={18} color={colors.muted} />
      </Pressable>
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
    </View>
  );
}

export function Avatar({ name, photo, size = 44 }: { name?: string; photo?: string; size?: number }) {
  // Employee.photo is a small data-URL the web client stores on the record.
  if (photo && photo.startsWith('data:image')) {
    return <Image source={{ uri: photo }} style={{ width: size, height: size, borderRadius: size / 2 }} accessibilityIgnoresInvertColors />;
  }
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={{ color: colors.primaryDark, fontWeight: '700', fontSize: size * 0.36 }}>{initialsOf(name)}</Text>
    </View>
  );
}

export function SectionTitle({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <View style={styles.sectionTitle}>
      <Text style={type.heading}>{title}</Text>
      {action && onAction ? (
        <Pressable onPress={onAction} hitSlop={10} accessibilityRole="button">
          <Text style={{ color: colors.primary, fontWeight: '600' }}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={colors.primary} />
      <Text style={[type.caption, { marginTop: spacing.md }]}>{label}</Text>
    </View>
  );
}

export function EmptyState({ icon, title, message }: { icon: IconName; title: string; message?: string }) {
  return (
    <View style={styles.center}>
      <Ionicons name={icon} size={40} color={colors.muted} />
      <Text style={[type.heading, { marginTop: spacing.md, textAlign: 'center' }]}>{title}</Text>
      {message ? <Text style={[type.caption, { marginTop: spacing.xs, textAlign: 'center' }]}>{message}</Text> : null}
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={styles.center}>
      <Ionicons name="cloud-offline-outline" size={40} color={colors.danger} />
      <Text style={[type.body, { marginTop: spacing.md, textAlign: 'center' }]}>{message}</Text>
      {onRetry ? <Button label="Try again" variant="secondary" onPress={onRetry} style={{ marginTop: spacing.lg, alignSelf: 'center' }} /> : null}
    </View>
  );
}

/** Inline error for forms and action results. */
export function Banner({ message, tone = 'danger' }: { message: string; tone?: Tone }) {
  return (
    <View style={[styles.banner, { backgroundColor: tones[tone].bg }]} accessibilityRole="alert">
      <Text style={{ color: tones[tone].fg, fontSize: 14, lineHeight: 20 }}>{message}</Text>
    </View>
  );
}

export function Row({ icon, title, subtitle, right, onPress }: {
  icon?: IconName; title: string; subtitle?: string; right?: React.ReactNode; onPress?: () => void;
}) {
  const content = (
    <>
      {icon ? (
        <View style={styles.rowIcon}><Ionicons name={icon} size={20} color={colors.primary} /></View>
      ) : null}
      <View style={{ flex: 1 }}>
        <Text style={type.body} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={type.caption} numberOfLines={2}>{subtitle}</Text> : null}
      </View>
      {right ?? (onPress ? <Ionicons name="chevron-forward" size={18} color={colors.muted} /> : null)}
    </>
  );
  if (!onPress) return <View style={styles.row}>{content}</View>;
  return (
    <Pressable onPress={onPress} android_ripple={{ color: colors.neutralSoft }} style={styles.row} accessibilityRole="button">
      {content}
    </Pressable>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string }[]; value: T; onChange: (value: T) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm, paddingVertical: spacing.xs }}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={[styles.segment, active && styles.segmentActive]}
          >
            <Text style={{ color: active ? '#FFFFFF' : colors.inkSoft, fontWeight: '600', fontSize: 13.5 }}>{option.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** Bottom sheet for short forms, confirmations and option lists. */
export function Sheet({ visible, title, onClose, children }: {
  visible: boolean; title: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <Pressable style={styles.sheetBackdrop} onPress={onClose} accessibilityLabel="Close" />
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          <View style={styles.sheetHandle} />
          <View style={styles.sectionTitle}>
            <Text style={type.heading}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={colors.muted} />
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: spacing.lg }}>
            {children}
          </ScrollView>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function Stat({ label, value, tone = 'primary' }: { label: string; value: string | number; tone?: Tone }) {
  return (
    <View style={[styles.stat, { backgroundColor: tones[tone].bg }]}>
      <Text style={{ fontSize: 20, fontWeight: '700', color: tones[tone].fg }}>{value}</Text>
      <Text style={[type.caption, { color: tones[tone].fg }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

export const layout = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statRow: { flexDirection: 'row', gap: spacing.sm },
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg,
    borderWidth: 1, borderColor: colors.border, marginBottom: spacing.md, overflow: 'hidden',
  },
  button: {
    minHeight: 48, borderRadius: radius.md, paddingHorizontal: spacing.lg,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  button_primary: { backgroundColor: colors.primary },
  button_secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  button_danger: { backgroundColor: colors.danger },
  button_ghost: { backgroundColor: 'transparent' },
  buttonDisabled: { opacity: 0.5 },
  buttonLabel: { fontSize: 15.5, fontWeight: '600' },
  chip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, alignSelf: 'flex-start' },
  chipLabel: { fontSize: 12, fontWeight: '700' },
  fieldLabel: { ...type.label, marginBottom: 6 },
  input: {
    minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: spacing.md, backgroundColor: colors.surface, fontSize: 15.5, color: colors.ink,
  },
  inputMultiline: { minHeight: 96, paddingTop: spacing.md, textAlignVertical: 'top' },
  inputError: { borderColor: colors.danger },
  pickerField: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fieldError: { color: colors.danger, fontSize: 12.5, marginTop: 4 },
  fieldHint: { ...type.caption, marginTop: 4 },
  avatar: { backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  sectionTitle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md, marginTop: spacing.sm },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, minHeight: 220 },
  banner: { padding: spacing.md, borderRadius: radius.md, marginBottom: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md, minHeight: 56 },
  rowIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  segment: {
    paddingHorizontal: spacing.lg, minHeight: 36, borderRadius: radius.pill, justifyContent: 'center',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  segmentActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  sheetBackdrop: { flex: 1, backgroundColor: colors.overlay },
  sheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: spacing.lg, paddingTop: spacing.sm, maxHeight: '85%',
  },
  sheetHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: spacing.sm },
  stat: { flex: 1, borderRadius: radius.md, padding: spacing.md, minHeight: 68, justifyContent: 'center' },
});
