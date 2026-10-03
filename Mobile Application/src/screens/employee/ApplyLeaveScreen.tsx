import React, { useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../../auth/AuthContext';
import { leaveApi } from '../../services/endpoints';
import { ApiError, errorMessage } from '../../services/api';
import { keys, useLeaveBalance } from '../../hooks/queries';
import { Banner, Button, ErrorState, Field, Loading, PickerField, Segmented, layout } from '../../components/ui';
import { colors, radius, spacing, type } from '../../theme';
import { formatDate, toISODate, todayIST } from '../../utils/date';
import { dateFromISO, pickDate } from '../../utils/pickers';
import type { StackProps } from '../../navigation/types';

// POST /leaves. Working days, holidays, overlap and balance are all computed
// by the server at submission; this form only collects the request.
export function ApplyLeaveScreen({ navigation }: StackProps<'ApplyLeave'>) {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const types = useQuery({ queryKey: keys.leaveTypes, queryFn: leaveApi.types, staleTime: 5 * 60_000 });
  const balance = useLeaveBalance(user.employeeId);

  const [chosenType, setTypeCode] = useState<string | null>(null);
  const [start, setStart] = useState(todayIST());
  const [end, setEnd] = useState(todayIST());
  const [halfDayWanted, setHalfDay] = useState(false);
  const [timing, setTiming] = useState<'first-half' | 'second-half'>('first-half');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  // The first configured type is preselected once the policy has loaded.
  const typeCode = chosenType ?? types.data?.[0]?.code ?? null;
  const selected = types.data?.find((t) => t.code === typeCode);
  const available = balance.data?.balances.find((b) => b.type === typeCode);

  const halfDay = halfDayWanted && Boolean(selected?.allowHalfDay);

  const submit = useMutation({
    mutationFn: () => leaveApi.create({
      empId: user.employeeId!,
      type: typeCode!,
      start,
      end: halfDay ? start : end,
      reason: reason.trim(),
      isHalfDay: halfDay,
      halfDayTiming: halfDay ? timing : undefined,
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['leaves'] });
      void queryClient.invalidateQueries({ queryKey: ['leaveBalance'] });
      navigation.goBack();
    },
    onError: (err) => {
      // A supporting document can only be attached from the web HRMS.
      if (err instanceof ApiError && err.code === 'DOCUMENT_REQUIRED') {
        setError(`${err.message} Please file this request from the web HRMS, where a document can be attached.`);
      } else {
        setError(errorMessage(err));
      }
    },
  });

  const validate = () => {
    if (!user.employeeId) return setError('Your login is not linked to an employee profile.');
    if (!typeCode) return setError('Choose a leave type.');
    if (!halfDay && end < start) return setError('The end date cannot be before the start date.');
    if (reason.trim().length < 3) return setError('Add a short reason for the request.');
    setError(null);
    submit.mutate();
  };

  if (types.isLoading) return <View style={layout.screen}><Loading /></View>;
  if (types.isError) return <View style={layout.screen}><ErrorState message={errorMessage(types.error)} onRetry={() => void types.refetch()} /></View>;

  return (
    <KeyboardAvoidingView behavior="padding" style={layout.screen}>
      <ScrollView contentContainerStyle={layout.content} keyboardShouldPersistTaps="handled">
        {error ? <Banner message={error} /> : null}

        <Text style={[type.label, { marginBottom: spacing.sm }]}>Leave type</Text>
        <View style={styles.types}>
          {types.data?.map((t) => {
            const active = t.code === typeCode;
            return (
              <Pressable key={t.code} onPress={() => setTypeCode(t.code)} style={[styles.type, active && styles.typeActive]} accessibilityRole="radio" accessibilityState={{ selected: active }}>
                <Text style={{ color: active ? colors.primaryDark : colors.inkSoft, fontWeight: '600', fontSize: 13.5 }}>{t.name}</Text>
              </Pressable>
            );
          })}
        </View>
        {available?.balanceTracked ? (
          <Text style={[type.caption, { marginBottom: spacing.lg }]}>{available.available} day(s) available{available.pending ? ` · ${available.pending} pending` : ''}</Text>
        ) : selected && !selected.paid ? (
          <Text style={[type.caption, { marginBottom: spacing.lg }]}>Unpaid leave is not deducted from a balance.</Text>
        ) : <View style={{ height: spacing.lg }} />}

        {selected?.allowHalfDay ? (
          <View style={[layout.rowBetween, { marginBottom: spacing.lg }]}>
            <Text style={type.body}>Half day</Text>
            <Switch value={halfDay} onValueChange={setHalfDay} trackColor={{ true: colors.primary }} accessibilityLabel="Half day" />
          </View>
        ) : null}

        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          <PickerField
            label={halfDay ? 'Date' : 'From'}
            value={formatDate(start)}
            icon="calendar-outline"
            onPress={() => pickDate({ value: dateFromISO(start), onPick: (d) => { const iso = toISODate(d); setStart(iso); if (end < iso) setEnd(iso); } })}
          />
          {!halfDay ? (
            <PickerField
              label="To"
              value={formatDate(end)}
              icon="calendar-outline"
              onPress={() => pickDate({ value: dateFromISO(end), min: dateFromISO(start), onPick: (d) => setEnd(toISODate(d)) })}
            />
          ) : null}
        </View>

        {halfDay ? (
          <View style={{ marginBottom: spacing.lg }}>
            <Segmented value={timing} onChange={setTiming} options={[{ value: 'first-half', label: 'First half' }, { value: 'second-half', label: 'Second half' }]} />
          </View>
        ) : null}

        <Field label="Reason" value={reason} onChangeText={setReason} multiline maxLength={1000} />

        <Button label="Submit request" onPress={validate} loading={submit.isPending} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  types: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  type: {
    paddingHorizontal: spacing.md, minHeight: 40, justifyContent: 'center', borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  typeActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
});
