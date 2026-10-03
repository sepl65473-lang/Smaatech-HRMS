import React, { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, Text } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSession } from '../../auth/AuthContext';
import { authApi } from '../../services/endpoints';
import { errorMessage } from '../../services/api';
import { Banner, Button, Field, layout } from '../../components/ui';
import { spacing, type } from '../../theme';
import { passwordProblem } from './ForgotPasswordScreen';

// Serves two routes: the voluntary change from Profile, and the forced change
// for an account still on its temporary password.
export function ChangePasswordScreen() {
  const navigation = useNavigation();
  const { user, reloadUser, signOut } = useSession();
  const forced = Boolean(user.mustChangePassword);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (!current) return setError('Enter your current password.');
    const problem = passwordProblem(next);
    if (problem) return setError(problem);
    if (next !== confirm) return setError('The new passwords do not match.');
    if (next === current) return setError('Choose a password different from the current one.');
    setError(null);
    setBusy(true);
    try {
      await authApi.changePassword(current, next);
      setCurrent(''); setNext(''); setConfirm('');
      if (forced) {
        // Clears mustChangePassword, which swaps the navigator to the app.
        await reloadUser();
      } else {
        setDone(true);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={layout.screen}>
      <ScrollView contentContainerStyle={layout.content} keyboardShouldPersistTaps="handled">
        {forced ? (
          <Text style={[type.body, { marginBottom: spacing.lg }]}>
            You signed in with a temporary password. Set your own password to continue.
          </Text>
        ) : null}
        {error ? <Banner message={error} /> : null}
        {done ? <Banner tone="success" message="Password changed. Your other sessions were signed out." /> : null}

        <Field label={forced ? 'Temporary password' : 'Current password'} value={current} onChangeText={setCurrent} secureTextEntry autoCapitalize="none" autoComplete="current-password" />
        <Field label="New password" value={next} onChangeText={setNext} secureTextEntry autoCapitalize="none" autoComplete="new-password" hint="At least 8 characters, with a letter and a number." />
        <Field label="Confirm new password" value={confirm} onChangeText={setConfirm} secureTextEntry autoCapitalize="none" autoComplete="new-password" />

        <Button label="Save password" onPress={submit} loading={busy} />
        {forced ? (
          <Button label="Sign out" variant="ghost" onPress={() => void signOut()} style={{ marginTop: spacing.sm }} />
        ) : done ? (
          <Button label="Done" variant="ghost" onPress={() => navigation.goBack()} style={{ marginTop: spacing.sm }} />
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
