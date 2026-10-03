import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../services/api';
import { attendanceApi } from '../../services/endpoints';
import { findRecordedPunch, prepareFrame, punchFailure, submitEnrollment, submitPunch } from '../../attendance/punch';
import { FIX_MAX_AGE_MS, getFreshFix, LocationError, type Fix } from '../../permissions/location';
import { useSettings } from '../../hooks/queries';
import { useSession } from '../../auth/AuthContext';
import { Button } from '../../components/ui';
import { colors, radius, spacing } from '../../theme';
import { formatTime } from '../../utils/date';
import { attendanceStatus } from '../../utils/format';
import type { StackProps } from '../../navigation/types';
import type { Attendance, LivenessChallenge } from '../../types';

type Phase =
  | { name: 'ready' }
  | { name: 'capturing'; prompt?: string }
  | { name: 'submitting' }
  | { name: 'success'; row?: Attendance; note?: string }
  | { name: 'failure'; title: string; message: string; code: string };

type LocationState =
  | { status: 'locating' }
  | { status: 'ready'; fix: Fix }
  | { status: 'error'; error: LocationError };

const PROMPTS: Record<LivenessChallenge['action'], string> = {
  'turn-left': 'Slowly turn your head to the LEFT',
  'turn-right': 'Slowly turn your head to the RIGHT',
  blink: 'Blink a few times',
};
const BURST_FRAMES = 5;
const BURST_GAP_MS = 350;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Camera capture for check-in, check-out and face enrolment.
 *
 * Nothing on this screen decides whether a face matched. It takes a photo (or
 * a liveness burst), attaches a fresh GPS reading, and reports exactly what
 * the server answered. "Recorded" is shown only for a server-confirmed punch.
 */
export function FaceCaptureScreen({ navigation, route }: StackProps<'FaceCapture'>) {
  const { mode, attendanceId } = route.params;
  const isPunch = mode !== 'enroll';
  const queryClient = useQueryClient();
  const settings = useSettings();
  const { user } = useSession();
  const camera = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: 'ready' });
  const [location, setLocation] = useState<LocationState>({ status: 'locating' });
  const alive = useRef(true);

  const busy = phase.name === 'capturing' || phase.name === 'submitting';

  // Reads the position without touching state; callers apply the result.
  const readLocation = useCallback(async (): Promise<LocationState> => {
    try {
      return { status: 'ready', fix: await getFreshFix() };
    } catch (err) {
      return { status: 'error', error: err instanceof LocationError ? err : new LocationError('UNAVAILABLE', 'Could not get your location.') };
    }
  }, []);

  const locate = useCallback(async (): Promise<Fix | null> => {
    setLocation({ status: 'locating' });
    const result = await readLocation();
    if (alive.current) setLocation(result);
    return result.status === 'ready' ? result.fix : null;
  }, [readLocation]);

  useEffect(() => {
    alive.current = true;
    if (isPunch) {
      void readLocation().then((result) => { if (alive.current) setLocation(result); });
    }
    return () => { alive.current = false; };
  }, [isPunch, readLocation]);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission]);

  // Leaving mid-upload would hide the server's answer, so back is held until it arrives.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => busy);
    return () => subscription.remove();
  }, [busy]);

  const shoot = async () => {
    const shot = await camera.current?.takePictureAsync({ quality: 0.8, shutterSound: false });
    if (!shot?.uri) throw new Error('capture-failed');
    return shot.uri;
  };

  const refreshAttendance = () => {
    void queryClient.invalidateQueries({ queryKey: ['attendance'] });
  };

  const capture = async () => {
    if (busy || !cameraReady) return;

    if (!isPunch) {
      try {
        setPhase({ name: 'capturing' });
        const shot = await shoot();
        setPhase({ name: 'submitting' });
        await submitEnrollment(await prepareFrame(shot));
        void queryClient.invalidateQueries({ queryKey: ['faceStatus'] });
        if (alive.current) setPhase({ name: 'success', note: 'Your face is enrolled. You can now check in with it.' });
      } catch (err) {
        if (alive.current) setPhase({ name: 'failure', ...failureOf(err) });
      }
      return;
    }

    if (!attendanceId) return;
    const direction = mode;
    try {
      // Policy is the server's; if it is unknown, a single photo is sent and
      // the server rejects it when liveness is in fact required.
      let challenge: LivenessChallenge | null = null;
      if (settings.data?.livenessRequired) challenge = await attendanceApi.challenge();

      setPhase({ name: 'capturing', prompt: challenge ? PROMPTS[challenge.action] : undefined });
      const shots: string[] = [];
      if (challenge) {
        const count = Math.min(Math.max(BURST_FRAMES, challenge.minFrames), challenge.maxFrames);
        await wait(700); // time to read the prompt before the first frame
        for (let i = 0; i < count; i += 1) {
          shots.push(await shoot());
          if (i < count - 1) await wait(BURST_GAP_MS);
        }
      } else {
        shots.push(await shoot());
      }

      setPhase({ name: 'submitting' });
      // Resized after the burst so processing does not stretch the gaps
      // between frames while the person is moving.
      const frames = await Promise.all(shots.map(prepareFrame));
      let fix = location.status === 'ready' ? location.fix : null;
      if (!fix || Date.now() - fix.timestamp > FIX_MAX_AGE_MS) fix = await locate();
      if (!fix) {
        if (alive.current) setPhase({ name: 'ready' });
        return;
      }

      const row = await submitPunch({ attendanceId, direction, frames, challengeId: challenge?.challengeId, fix });
      refreshAttendance();
      if (alive.current) setPhase({ name: 'success', row });
    } catch (err) {
      refreshAttendance();
      // The upload may have landed even though the reply never arrived.
      if (err instanceof ApiError && err.isTransport) {
        const recorded = user.employeeId ? await findRecordedPunch(user.employeeId, direction) : null;
        if (recorded) {
          if (alive.current) setPhase({ name: 'success', row: recorded });
          return;
        }
      }
      if (alive.current) setPhase({ name: 'failure', ...failureOf(err) });
    }
  };

  const close = () => navigation.goBack();
  const title = mode === 'enroll' ? 'Enrol your face' : mode === 'in' ? 'Check in' : 'Check out';

  if (phase.name === 'success') {
    const row = phase.row;
    const time = row ? (mode === 'in' ? row.checkIn : row.checkOut) : null;
    return (
      <Result
        icon="checkmark-circle"
        tone={colors.success}
        title={mode === 'enroll' ? 'Face enrolled' : mode === 'in' ? 'Checked in' : 'Checked out'}
        message={row
          ? `Recorded at ${formatTime(time)} · ${attendanceStatus(row.status).label}${(mode === 'in' ? row.checkInAddress : row.checkOutAddress) ? `\n${mode === 'in' ? row.checkInAddress : row.checkOutAddress}` : ''}`
          : phase.note ?? ''}
      >
        <Button label="Done" onPress={close} />
      </Result>
    );
  }

  if (phase.name === 'failure') {
    const final = ['NOT_ENROLLED', 'ALREADY_CHECKED_IN', 'ALREADY_CHECKED_OUT', 'CHECKOUT_TOO_EARLY', 'NOT_CHECKED_IN', 'TOO_MANY_FAILED_ATTEMPTS', 'REVERIFICATION_NOT_AUTHORISED', 'FORBIDDEN'].includes(phase.code);
    return (
      <Result icon="close-circle" tone={colors.danger} title={phase.title} message={phase.message}>
        {phase.code === 'NOT_ENROLLED' ? (
          <Button label="Enrol my face" onPress={() => navigation.replace('FaceCapture', { mode: 'enroll' })} />
        ) : !final ? (
          <Button label="Try again" onPress={() => { setPhase({ name: 'ready' }); void locate(); }} />
        ) : null}
        <Button label="Close" variant={final ? 'primary' : 'ghost'} onPress={close} style={{ marginTop: spacing.sm }} />
      </Result>
    );
  }

  if (!permission) return <View style={styles.dark} />;

  if (!permission.granted) {
    return (
      <Result icon="camera-outline" tone={colors.primary} title="Camera access needed" message="The camera is used only to verify your face when you record attendance.">
        {permission.canAskAgain
          ? <Button label="Allow camera" onPress={() => void requestPermission()} />
          : <Button label="Open app settings" onPress={() => void Linking.openSettings()} />}
        <Button label="Cancel" variant="ghost" onPress={close} style={{ marginTop: spacing.sm }} />
      </Result>
    );
  }

  if (cameraError) {
    return (
      <Result icon="videocam-off-outline" tone={colors.danger} title="Camera unavailable" message={cameraError}>
        <Button label="Try again" onPress={() => { setCameraError(null); setCameraReady(false); }} />
        <Button label="Cancel" variant="ghost" onPress={close} style={{ marginTop: spacing.sm }} />
      </Result>
    );
  }

  const locationBlocked = isPunch && location.status !== 'ready';

  return (
    <View style={styles.dark}>
      <CameraView
        ref={camera}
        style={StyleSheet.absoluteFill}
        facing="front"
        mirror={false}
        animateShutter={false}
        onCameraReady={() => setCameraReady(true)}
        onMountError={(event) => setCameraError(event.message || 'The camera could not be started. Close other apps using it and try again.')}
      />
      <SafeAreaView style={styles.overlay}>
        <View style={styles.topBar}>
          <Pressable onPress={close} disabled={busy} hitSlop={14} accessibilityRole="button" accessibilityLabel="Cancel" style={{ opacity: busy ? 0.4 : 1 }}>
            <Ionicons name="close" size={28} color="#FFFFFF" />
          </Pressable>
          <Text style={styles.title}>{title}</Text>
          <View style={{ width: 28 }} />
        </View>

        <View style={styles.guideWrap} pointerEvents="none">
          <View style={styles.guide} />
          <Text style={styles.prompt}>
            {phase.name === 'capturing' && phase.prompt ? phase.prompt
              : phase.name === 'submitting' ? 'Verifying with the server…'
              : phase.name === 'capturing' ? 'Hold still…'
              : 'Centre your face in the frame'}
          </Text>
        </View>

        <View style={styles.bottom}>
          {isPunch ? <LocationLine state={location} onRetry={() => void locate()} /> : null}
          {busy ? (
            <View style={styles.shutterBusy}><ActivityIndicator color="#FFFFFF" size="large" /></View>
          ) : (
            <Pressable
              onPress={() => void capture()}
              disabled={!cameraReady || locationBlocked}
              accessibilityRole="button"
              accessibilityLabel={`Capture photo to ${title.toLowerCase()}`}
              style={[styles.shutter, (!cameraReady || locationBlocked) && { opacity: 0.35 }]}
            >
              <View style={styles.shutterInner} />
            </Pressable>
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

function failureOf(err: unknown) {
  if (err instanceof Error && err.message === 'capture-failed') {
    return { code: 'CAPTURE_FAILED', title: 'Could not take the photo', message: 'The camera did not return a picture. Please try again.' };
  }
  return punchFailure(err);
}

function LocationLine({ state, onRetry }: { state: LocationState; onRetry: () => void }) {
  if (state.status === 'locating') {
    return (
      <View style={styles.locationLine}>
        <ActivityIndicator color="#FFFFFF" size="small" />
        <Text style={styles.locationText}>Getting your location…</Text>
      </View>
    );
  }
  if (state.status === 'ready') {
    return (
      <View style={styles.locationLine}>
        <Ionicons name="location" size={16} color="#7CE0B2" />
        <Text style={styles.locationText}>
          Location ready{state.fix.accuracy != null ? ` · within ${Math.round(state.fix.accuracy)} m` : ''}
        </Text>
      </View>
    );
  }
  const blocked = state.error.code === 'PERMISSION_BLOCKED';
  return (
    <View style={styles.locationError}>
      <Text style={[styles.locationText, { marginLeft: 0, marginBottom: spacing.sm }]}>{state.error.message}</Text>
      <Button
        label={blocked ? 'Open app settings' : 'Try again'}
        variant="secondary"
        onPress={blocked ? () => void Linking.openSettings() : onRetry}
      />
    </View>
  );
}

function Result({ icon, tone, title, message, children }: {
  icon: React.ComponentProps<typeof Ionicons>['name']; tone: string; title: string; message: string; children: React.ReactNode;
}) {
  return (
    <SafeAreaView style={styles.result}>
      <View style={styles.resultBody}>
        <Ionicons name={icon} size={72} color={tone} />
        <Text style={styles.resultTitle}>{title}</Text>
        <Text style={styles.resultMessage}>{message}</Text>
      </View>
      <View style={{ padding: spacing.xl }}>{children}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  dark: { flex: 1, backgroundColor: '#0F172A' },
  overlay: { flex: 1, justifyContent: 'space-between' },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing.lg },
  title: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
  guideWrap: { alignItems: 'center' },
  guide: { width: 240, height: 310, borderRadius: 150, borderWidth: 3, borderColor: 'rgba(255,255,255,0.9)' },
  prompt: {
    color: '#FFFFFF', fontSize: 16, fontWeight: '600', marginTop: spacing.lg, textAlign: 'center',
    backgroundColor: 'rgba(15,23,42,0.6)', paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.pill, overflow: 'hidden',
  },
  bottom: { alignItems: 'center', paddingBottom: spacing.xl, paddingHorizontal: spacing.lg },
  locationLine: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(15,23,42,0.6)',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill, marginBottom: spacing.lg,
  },
  locationError: { backgroundColor: 'rgba(15,23,42,0.85)', padding: spacing.md, borderRadius: radius.md, marginBottom: spacing.lg, alignSelf: 'stretch' },
  locationText: { color: '#FFFFFF', fontSize: 13.5, marginLeft: spacing.sm },
  shutter: { width: 78, height: 78, borderRadius: 39, borderWidth: 4, borderColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  shutterInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#FFFFFF' },
  shutterBusy: { width: 78, height: 78, alignItems: 'center', justifyContent: 'center' },
  result: { flex: 1, backgroundColor: colors.background },
  resultBody: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  resultTitle: { fontSize: 22, fontWeight: '700', color: colors.ink, marginTop: spacing.lg, textAlign: 'center' },
  resultMessage: { fontSize: 15, color: colors.inkSoft, marginTop: spacing.sm, textAlign: 'center', lineHeight: 22 },
});
