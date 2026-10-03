import React, { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, Text, View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../../auth/AuthContext';
import { correctionsApi } from '../../services/endpoints';
import { errorMessage } from '../../services/api';
import { keys } from '../../hooks/queries';
import { Banner, Button, Field, PickerField, layout } from '../../components/ui';
import { spacing, type } from '../../theme';
import { formatDate, formatTime, toHHMM, toISODate, todayIST } from '../../utils/date';
import { dateAt, dateFromISO, pickDate, pickTime } from '../../utils/pickers';
import type { StackProps } from '../../navigation/types';

// POST /attendance-corrections. HR reviews the request on approval; nothing
// changes on the attendance record until then.
export function CorrectionScreen({ navigation, route }: StackProps<'Correction'>) {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [date, setDate] = useState(route.params?.date ?? todayIST());
  const [checkIn, setCheckIn] = useState('09:00');
  const [checkOut, setCheckOut] = useState('18:00');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: () => correctionsApi.create({
      employeeId: user.employeeId!, date, requestedCheckIn: checkIn, requestedCheckOut: checkOut, reason: reason.trim(),
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.corrections });
      navigation.goBack();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const validate = () => {
    if (!user.employeeId) return setError('Your login is not linked to an employee profile.');
    if (checkOut <= checkIn) return setError('Check-out must be later than check-in.');
    if (reason.trim().length < 5) return setError('Explain briefly why the record needs correcting.');
    setError(null);
    submit.mutate();
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={layout.screen}>
      <ScrollView contentContainerStyle={layout.content} keyboardShouldPersistTaps="handled">
        <Text style={[type.caption, { marginBottom: spacing.lg }]}>
          Request the times your attendance should show. HR reviews every request.
        </Text>
        {error ? <Banner message={error} /> : null}

        <PickerField
          label="Date"
          value={formatDate(date)}
          icon="calendar-outline"
          onPress={() => pickDate({ value: dateFromISO(date), max: new Date(), onPick: (d) => setDate(toISODate(d)) })}
        />
        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          <PickerField label="Check in" value={formatTime(checkIn)} icon="time-outline" onPress={() => pickTime({ value: dateAt(checkIn), onPick: (d) => setCheckIn(toHHMM(d)) })} />
          <PickerField label="Check out" value={formatTime(checkOut)} icon="time-outline" onPress={() => pickTime({ value: dateAt(checkOut), onPick: (d) => setCheckOut(toHHMM(d)) })} />
        </View>
        <Field label="Reason" value={reason} onChangeText={setReason} multiline maxLength={1000} placeholder="For example: forgot to check out after the client visit" />

        <Button label="Submit request" onPress={validate} loading={submit.isPending} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
