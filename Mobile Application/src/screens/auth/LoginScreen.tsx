import React, { useRef, useState } from 'react';
import { Image, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../services/api';
import { Banner, Button, Field } from '../../components/ui';
import { colors, radius, spacing, type } from '../../theme';
import { APP_VERSION } from '../../config/env';
import type { StackProps } from '../../navigation/types';

export function LoginScreen({ navigation }: StackProps<'Login'>) {
  const { signIn, notice } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const passwordRef = useRef<TextInput>(null);

  const submit = async () => {
    if (submitting) return;
    if (!identifier.trim() || !password) {
      setError('Enter your email or mobile number and your password.');
      return;
    }
    setError(null);
    setSubmitting(true);
    // The API may be waking from idle; say so rather than leave a bare spinner.
    const slowTimer = setTimeout(() => setSlow(true), 6000);
    try {
      await signIn(identifier, password);
    } catch (err) {
      setPassword('');
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Please try again.');
    } finally {
      clearTimeout(slowTimer);
      setSlow(false);
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <View style={styles.logoWrap}>
              <Image source={require('../../../assets/logo.png')} style={styles.logo} resizeMode="contain" accessibilityLabel="Smaatech logo" />
            </View>
            <Text style={styles.product}>Smaatech HRMS</Text>
            <Text style={type.caption}>Sign in with your HRMS account</Text>
          </View>

          {notice && !error ? <Banner message={notice} tone="warning" /> : null}
          {error ? <Banner message={error} /> : null}

          <Field
            label="Email or mobile number"
            value={identifier}
            onChangeText={setIdentifier}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            keyboardType="email-address"
            returnKeyType="next"
            onSubmitEditing={() => passwordRef.current?.focus()}
            editable={!submitting}
          />

          <View style={{ marginBottom: spacing.sm }}>
            <Text style={[type.label, { marginBottom: 6 }]}>Password</Text>
            <View style={styles.passwordRow}>
              <TextInput
                ref={passwordRef}
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="current-password"
                returnKeyType="go"
                onSubmitEditing={submit}
                editable={!submitting}
                accessibilityLabel="Password"
                style={styles.passwordInput}
              />
              <Pressable onPress={() => setShowPassword((v) => !v)} hitSlop={12} accessibilityRole="button" accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}>
                <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={22} color={colors.muted} />
              </Pressable>
            </View>
          </View>

          <Pressable onPress={() => navigation.navigate('ForgotPassword')} hitSlop={10} style={styles.forgot} accessibilityRole="button">
            <Text style={{ color: colors.primary, fontWeight: '600' }}>Forgot password?</Text>
          </Pressable>

          <Button label="Sign in" onPress={submit} loading={submitting} />
          {slow ? <Text style={[type.caption, styles.slow]}>The server is waking up. This can take up to a minute…</Text> : null}
          <Text style={[type.caption, styles.slow]}>
            Your location is recorded when you sign in, if you allow it. You can sign in without sharing it.
          </Text>

          <Text style={[type.caption, styles.version]}>Version {APP_VERSION}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl },
  brand: { alignItems: 'center', marginBottom: spacing.xxl },
  logoWrap: {
    width: 104, height: 104, borderRadius: 24, backgroundColor: colors.surface, alignItems: 'center',
    justifyContent: 'center', borderWidth: 1, borderColor: colors.border, marginBottom: spacing.lg,
  },
  logo: { width: 80, height: 80 },
  product: { fontSize: 24, fontWeight: '700', color: colors.ink, marginBottom: 4 },
  passwordRow: {
    flexDirection: 'row', alignItems: 'center', minHeight: 48, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, backgroundColor: colors.surface, paddingHorizontal: spacing.md,
  },
  passwordInput: { flex: 1, fontSize: 15.5, color: colors.ink, paddingVertical: 0 },
  forgot: { alignSelf: 'flex-end', marginBottom: spacing.xl, paddingVertical: spacing.xs },
  slow: { textAlign: 'center', marginTop: spacing.md },
  version: { textAlign: 'center', marginTop: spacing.xxl },
});
