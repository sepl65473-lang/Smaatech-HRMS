import React, { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, Text } from 'react-native';
import { authApi } from '../../services/endpoints';
import { errorMessage } from '../../services/api';
import { Banner, Button, Field, layout } from '../../components/ui';
import { spacing, type } from '../../theme';
import type { StackProps } from '../../navigation/types';

// Same policy the server enforces (server/src/lib/passwordPolicy.js).
export const passwordProblem = (pw: string) =>
  pw.length >= 8 && /[A-Za-z]/.test(pw) && /\d/.test(pw) ? null : 'Use at least 8 characters, including a letter and a number.';

export function ForgotPasswordScreen({ navigation }: StackProps<'ForgotPassword'>) {
  const [step, setStep] = useState<'email' | 'code' | 'done'>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestCode = async () => {
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setError('Enter the email address of your HRMS account.');
    setError(null);
    setBusy(true);
    try {
      await authApi.forgotPassword(email.trim().toLowerCase());
      setStep('code');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!/^\d{6}$/.test(otp)) return setError('Enter the 6-digit code from the email.');
    const problem = passwordProblem(password);
    if (problem) return setError(problem);
    setError(null);
    setBusy(true);
    try {
      await authApi.resetPassword(email.trim().toLowerCase(), otp, password);
      setStep('done');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={layout.screen}>
      <ScrollView contentContainerStyle={layout.content} keyboardShouldPersistTaps="handled">
        {error ? <Banner message={error} /> : null}

        {step === 'email' ? (
          <>
            <Text style={[type.body, { marginBottom: spacing.lg }]}>Enter your account email. If it is registered, a 6-digit verification code is sent to it.</Text>
            <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" />
            <Button label="Send code" onPress={requestCode} loading={busy} />
          </>
        ) : null}

        {step === 'code' ? (
          <>
            <Text style={[type.body, { marginBottom: spacing.lg }]}>If {email.trim()} is registered, a code is on its way. It is valid for 10 minutes.</Text>
            <Field label="Verification code" value={otp} onChangeText={(v) => setOtp(v.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" autoComplete="one-time-code" maxLength={6} />
            <Field label="New password" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoComplete="new-password" hint="At least 8 characters, with a letter and a number." />
            <Button label="Reset password" onPress={reset} loading={busy} />
            <Button label="Send a new code" variant="ghost" onPress={requestCode} disabled={busy} style={{ marginTop: spacing.sm }} />
          </>
        ) : null}

        {step === 'done' ? (
          <>
            <Banner tone="success" message="Your password was changed and every other session was signed out." />
            <Button label="Back to sign in" onPress={() => navigation.goBack()} />
          </>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
