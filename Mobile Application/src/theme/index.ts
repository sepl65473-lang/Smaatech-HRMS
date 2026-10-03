// Brand values come from the web client (client/src/index.css, manifest.json)
// so both products read as one.
export const colors = {
  primary: '#3B7DDD',
  primaryDark: '#2B62B5',
  primarySoft: '#E6EFFC',
  background: '#EEF2F8',
  surface: '#FFFFFF',
  ink: '#1B2638',
  inkSoft: '#3D4A60',
  muted: '#6B7A90',
  border: '#DCE3EE',
  success: '#12915E',
  successSoft: '#E1F5EC',
  warning: '#B7791F',
  warningSoft: '#FCF2DC',
  danger: '#D03B4B',
  dangerSoft: '#FCE8EA',
  info: '#5B6BD6',
  infoSoft: '#E9EBFB',
  neutralSoft: '#EDF0F5',
  overlay: 'rgba(15, 23, 42, 0.55)',
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 };

export const type = {
  title: { fontSize: 22, fontWeight: '700' as const, color: colors.ink },
  heading: { fontSize: 17, fontWeight: '600' as const, color: colors.ink },
  body: { fontSize: 15, color: colors.ink },
  label: { fontSize: 13, fontWeight: '600' as const, color: colors.inkSoft },
  caption: { fontSize: 12.5, color: colors.muted },
};

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'primary';

export const tones: Record<Tone, { fg: string; bg: string }> = {
  success: { fg: colors.success, bg: colors.successSoft },
  warning: { fg: colors.warning, bg: colors.warningSoft },
  danger: { fg: colors.danger, bg: colors.dangerSoft },
  info: { fg: colors.info, bg: colors.infoSoft },
  neutral: { fg: colors.muted, bg: colors.neutralSoft },
  primary: { fg: colors.primaryDark, bg: colors.primarySoft },
};
