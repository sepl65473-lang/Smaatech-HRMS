import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { leaveApi } from '../services/endpoints';
import { errorMessage } from '../services/api';
import { Banner, Button, Field, Sheet } from './ui';
import { spacing, type } from '../theme';
import { formatRange } from '../utils/date';
import { titleCase } from '../utils/format';
import type { Leave } from '../types';

type Props = { leave: Leave | null; onClose: () => void; onDecided: () => void };

/**
 * Approve or reject one leave request. Who may decide the current stage is
 * the server's call (routes/leave.js canDecide); a refusal is shown as-is.
 * Keyed by request so the note and any error start empty for each one.
 */
export function LeaveDecisionSheet(props: Props) {
  return <DecisionSheet key={props.leave?.id ?? 'none'} {...props} />;
}

function DecisionSheet({ leave, onClose, onDecided }: Props) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'decline') =>
      decision === 'approve' ? leaveApi.approve(leave!.id, note.trim()) : leaveApi.decline(leave!.id, note.trim()),
    onSuccess: () => { onDecided(); onClose(); },
    onError: (err) => { setError(errorMessage(err)); onDecided(); },
  });

  const reject = () => {
    // The employee is told the reason, so one is always collected.
    if (note.trim().length < 3) return setError('Give a reason so the employee knows why it was rejected.');
    setError(null);
    decide.mutate('decline');
  };

  return (
    <Sheet visible={Boolean(leave)} title="Leave request" onClose={decide.isPending ? () => undefined : onClose}>
      {leave ? (
        <View>
          <Text style={type.body}>{leave.name} · {leave.dept}</Text>
          <Text style={[type.caption, { marginTop: 2 }]}>
            {titleCase(leave.type)} leave · {formatRange(leave.start, leave.end)} · {leave.isHalfDay ? 'Half day' : `${leave.workingDays ?? 0} day(s)`}
          </Text>
          {leave.reason ? <Text style={[type.caption, { marginTop: spacing.sm }]}>{leave.reason}</Text> : null}
          <View style={{ height: spacing.lg }} />
          {error ? <Banner message={error} /> : null}
          <Field label="Note (required to reject)" value={note} onChangeText={setNote} multiline maxLength={1000} />
          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            <Button label="Reject" variant="danger" onPress={reject} loading={decide.isPending && decide.variables === 'decline'} disabled={decide.isPending} style={{ flex: 1 }} />
            <Button label="Approve" onPress={() => { setError(null); decide.mutate('approve'); }} loading={decide.isPending && decide.variables === 'approve'} disabled={decide.isPending} style={{ flex: 1 }} />
          </View>
        </View>
      ) : null}
    </Sheet>
  );
}
