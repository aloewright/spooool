// Mantine theme that reproduces the spooool (strand.css) visual identity.
//
// The whole-app migration to Mantine (owner decision: keep the current look)
// hinges on this file. Rather than duplicate strand's OKLCH values in JS — which
// would create a second source of truth that drifts — we bind Mantine's own
// surface/text CSS variables to strand's existing custom properties. strand.css
// already re-defines every token under `.dark` (strand.css:140), so Mantine's
// light/dark, shadows, and fonts all follow strand automatically with no
// `dark.colors` table to maintain. The root MantineProvider sets
// `forceColorScheme` from the `.dark` class (router.tsx), so Mantine's
// data-mantine-color-scheme always matches strand.
//
// Verified against strand.css: --btn radius = --radius-md (~8px, rounded-rect),
// --input radius = --radius-pill (9999px), --card radius = --radius-xl (~14px);
// --shadow-card/--shadow-float defined in both :root and .dark.
import { createTheme, type CSSVariablesResolver, rem } from '@mantine/core';

export const spoolTheme = createTheme({
  primaryColor: 'spool',
  // strand --primary is near-black in light, near-white in dark. Shade 9 is the
  // darkest, shade 1 near-lightest — so filled primary buttons match strand in
  // both schemes (with autoContrast picking readable text).
  primaryShade: { light: 9, dark: 1 },
  autoContrast: true,
  colors: {
    // Near-greyscale ramp lifted from strand's OKLCH ladder (light → dark).
    spool: [
      'oklch(0.985 0 0)',
      'oklch(0.965 0 0)',
      'oklch(0.94 0 0)',
      'oklch(0.9 0 0)',
      'oklch(0.6 0 0)',
      'oklch(0.38 0 0)',
      'oklch(0.27 0 0)',
      'oklch(0.225 0 0)',
      'oklch(0.195 0 0)',
      'oklch(0.12 0 0)',
    ],
    // Chromatic destructive ramp (strand --destructive is hue 25, C ~0.15) so
    // Alert/Button color="red" matches strand instead of going greyscale.
    red: [
      'oklch(0.95 0.03 25)',
      'oklch(0.9 0.05 25)',
      'oklch(0.82 0.08 25)',
      'oklch(0.75 0.12 25)',
      'oklch(0.7 0.15 25)',
      'oklch(0.62 0.15 25)',
      'oklch(0.55 0.15 25)',
      'oklch(0.48 0.14 25)',
      'oklch(0.4 0.12 25)',
      'oklch(0.32 0.1 25)',
    ],
  },
  // Reuse strand's already-loaded @font-face stacks (no re-declaration, no FOUT).
  fontFamily: 'var(--font-sans)',
  fontFamilyMonospace: 'var(--font-mono)',
  headings: {
    fontFamily: 'var(--font-sans)',
    fontWeight: '700',
    sizes: {
      h1: { fontSize: rem(30), lineHeight: '1.2' },
      h2: { fontSize: rem(24), lineHeight: '1.2' },
      h3: { fontSize: rem(20), lineHeight: '1.2' },
    },
  },
  // Mantine radius scale mapped onto strand's radius tokens.
  defaultRadius: 'md',
  radius: {
    xs: 'var(--radius-sm)', // ~6px
    sm: 'var(--radius-md)', // ~8px  (strand .btn)
    md: 'var(--radius)', //    10px
    lg: 'var(--radius-xl)', // ~14px (strand .card)
    xl: 'var(--radius-pill)', // 9999px pill (strand .input, badges)
  },
  // Map to strand's shadows so dark-mode inset highlights apply automatically.
  shadows: {
    xs: 'var(--shadow-card)',
    sm: 'var(--shadow-card)',
    md: 'var(--shadow-card)',
    lg: 'var(--shadow-float)',
    xl: 'var(--shadow-float)',
  },
  components: {
    Button: { defaultProps: { radius: 'sm' } }, // strand .btn = --radius-md
    Badge: { defaultProps: { radius: 'xl' } }, // pill
    TextInput: { defaultProps: { radius: 'xl' } }, // strand .input = pill
    PasswordInput: { defaultProps: { radius: 'xl' } },
    Select: { defaultProps: { radius: 'xl' } },
    NumberInput: { defaultProps: { radius: 'xl' } },
    FileInput: { defaultProps: { radius: 'xl' } },
    Textarea: { defaultProps: { radius: 'md' } }, // multiline: avoid pill
    Card: { defaultProps: { radius: 'lg', withBorder: true, padding: 'lg' } },
    Paper: { defaultProps: { radius: 'lg' } },
  },
});

// Bind Mantine's surface/text variables to strand tokens so every Mantine
// component inherits strand's palette — and dark mode — without per-component
// overrides. `light`/`dark` stay empty because strand.css already flips the
// underlying tokens under `.dark`.
export const spoolCssVarsResolver: CSSVariablesResolver = () => ({
  variables: {
    '--mantine-color-body': 'var(--background)',
    '--mantine-color-text': 'var(--foreground)',
    '--mantine-color-default': 'var(--card)',
    '--mantine-color-default-border': 'var(--border)',
    '--mantine-color-dimmed': 'var(--muted-foreground)',
    '--mantine-color-placeholder': 'var(--muted-foreground)',
    '--mantine-color-error': 'var(--destructive)',
  },
  light: {},
  dark: {},
});
