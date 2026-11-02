// SPDX-License-Identifier: AGPL-3.0-or-later

// Use the same semantic palette as the timeline, assistant and settings.
// CSS variables also follow explicit Perfetto theme changes without JS detection.
export function getTokens() {
  return {
    bg: 'var(--pf-color-background)',
    surface: 'var(--pf-color-background-secondary)',
    surfaceHover: 'var(--pf-color-background-tertiary)',
    border: 'var(--pf-color-border)',
    text: 'var(--pf-color-text)',
    textSecondary: 'var(--pf-color-text-muted)',
    textMuted: 'var(--pf-color-text-hint)',
    accent: 'var(--pf-color-primary)',
    accentHover: 'var(--pf-color-interactive-base)',
    accentGradient: 'var(--pf-color-primary)',
    success: 'var(--pf-color-success)',
    warning: 'var(--pf-color-warning)',
    error: 'var(--pf-color-danger)',
    cardGradient: 'var(--pf-color-background)',
  };
}

export type Tokens = ReturnType<typeof getTokens>;

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function STYLES(t: Tokens) {
  return {
    // ── Layout ──────────────────────────────────────────────────────────────
    container: {
      padding: '20px',
      height: '100%',
      overflow: 'hidden' as const,
      backgroundColor: t.bg,
      color: t.text,
    },
    header: {
      display: 'flex' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
      marginBottom: '20px',
    },
    title: {
      margin: 0,
      fontSize: '18px',
      fontWeight: 600,
      color: t.text,
    },
    subtitle: {
      margin: '4px 0 0 0',
      fontSize: '13px',
      color: t.textSecondary,
    },

    // ── Add button ───────────────────────────────────────────
    addBtn: {
      display: 'inline-flex' as const,
      alignItems: 'center' as const,
      gap: '6px',
      padding: '10px 18px',
      border: 'none',
      borderRadius: '8px',
      fontSize: '14px',
      fontWeight: 500,
      cursor: 'pointer',
      background: t.accentGradient,
      color: 'var(--pf-color-text-on-primary)',
      transition: 'background 0.15s ease, border-color 0.15s ease',
    },

    // ── Provider grid ────────────────────────────────────────────────────────
    grid: {
      display: 'grid' as const,
      gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
      gap: '14px',
    },
    card: {
      padding: '16px',
      borderRadius: '10px',
      border: `1px solid ${t.border}`,
      background: t.cardGradient,
      boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
      transition: 'background 0.15s ease, border-color 0.15s ease',
      position: 'relative' as const,
      cursor: 'default',
    },
    cardActive: {
      borderLeft: `3px solid ${t.accent}`,
      boxShadow: `0 0 12px color-mix(in srgb, ${t.accent} 20%, transparent)`,
    },
    cardHeader: {
      display: 'flex' as const,
      alignItems: 'center' as const,
      gap: '10px',
      marginBottom: '10px',
    },
    cardIcon: {
      fontSize: '24px',
      width: '36px',
      height: '36px',
      display: 'flex' as const,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      borderRadius: '8px',
      backgroundColor: t.bg,
      flexShrink: 0,
    },
    cardName: {
      fontSize: '15px',
      fontWeight: 600,
      color: t.text,
      margin: 0,
      overflow: 'hidden' as const,
      textOverflow: 'ellipsis' as const,
      whiteSpace: 'nowrap' as const,
    },

    // ── Badges ───────────────────────────────────────────────────────────────
    cardBadge: {
      display: 'inline-flex' as const,
      alignItems: 'center' as const,
      gap: '4px',
      padding: '2px 8px',
      borderRadius: '12px',
      fontSize: '11px',
      fontWeight: 500,
    },
    activeBadge: {
      background: t.accentGradient,
      color: 'var(--pf-color-text-on-primary)',
    },
    categoryBadge: {
      backgroundColor: `color-mix(in srgb, ${t.accent} 13%, transparent)`,
      color: t.accent,
    },

    // ── Card content ─────────────────────────────────────────────────────────
    cardModels: {
      marginTop: '8px',
      fontSize: '12px',
      color: t.textSecondary,
      fontFamily: 'monospace',
      lineHeight: '1.6',
      backgroundColor: t.bg,
      padding: '6px 8px',
      borderRadius: '6px',
    },
    cardActions: {
      display: 'flex' as const,
      gap: '6px',
      marginTop: '12px',
      borderTop: `1px solid ${t.border}`,
      paddingTop: '12px',
    },
    actionBtn: {
      display: 'inline-flex' as const,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      padding: '6px 10px',
      border: `1px solid ${t.border}`,
      borderRadius: '6px',
      fontSize: '12px',
      cursor: 'pointer',
      backgroundColor: 'transparent',
      color: t.textSecondary,
      transition: 'background 0.15s ease, border-color 0.15s ease',
      gap: '4px',
    },
    actionBtnDanger: {
      borderColor: `color-mix(in srgb, ${t.error} 40%, transparent)`,
      color: t.error,
    },

    // ── Empty / loading states ────────────────────────────────────────────────
    emptyState: {
      textAlign: 'center' as const,
      padding: '60px 20px',
      color: t.textSecondary,
    },
    emptyIcon: {
      fontSize: '48px',
      marginBottom: '16px',
      opacity: 0.6,
    },
    loadingState: {
      display: 'flex' as const,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      padding: '60px 20px',
      color: t.textSecondary,
      fontSize: '14px',
      gap: '8px',
    },

    // ── Banners ───────────────────────────────────────────────────────────────
    errorBanner: {
      display: 'flex' as const,
      gap: '10px',
      padding: '12px 14px',
      borderRadius: '8px',
      fontSize: '13px',
      marginBottom: '16px',
      backgroundColor: `color-mix(in srgb, ${t.error} 8%, transparent)`,
      border: `1px solid color-mix(in srgb, ${t.error} 25%, transparent)`,
      color: t.error,
    },
    successBanner: {
      display: 'flex' as const,
      gap: '10px',
      padding: '12px 14px',
      borderRadius: '8px',
      fontSize: '13px',
      marginBottom: '16px',
      backgroundColor: `color-mix(in srgb, ${t.success} 8%, transparent)`,
      border: `1px solid color-mix(in srgb, ${t.success} 25%, transparent)`,
      color: t.success,
    },
    warningBanner: {
      display: 'flex' as const,
      gap: '10px',
      padding: '12px 14px',
      borderRadius: '8px',
      fontSize: '13px',
      marginBottom: '16px',
      backgroundColor: `color-mix(in srgb, ${t.warning} 8%, transparent)`,
      border: `1px solid color-mix(in srgb, ${t.warning} 25%, transparent)`,
      color: t.warning,
    },

    // ── Form ──────────────────────────────────────────────────────────────────
    form: {
      padding: '20px',
    },
    formSection: {
      marginBottom: '24px',
    },
    formSectionTitle: {
      margin: '0 0 14px 0',
      fontSize: '13px',
      fontWeight: 600,
      color: t.textSecondary,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.8px',
    },
    formField: {
      marginBottom: '16px',
    },
    formLabel: {
      display: 'block' as const,
      marginBottom: '6px',
      fontSize: '13px',
      fontWeight: 500,
      color: t.text,
    },
    formInput: {
      width: '100%',
      padding: '10px 12px',
      border: `1px solid ${t.border}`,
      borderRadius: '8px',
      backgroundColor: t.surface,
      color: t.text,
      fontSize: '14px',
      boxSizing: 'border-box' as const,
      transition: 'background 0.15s ease, border-color 0.15s ease',
      fontFamily: 'inherit',
    },
    formInputFocus: {
      border: `1px solid ${t.accent}`,
      boxShadow: `0 0 0 3px color-mix(in srgb, ${t.accent} 13%, transparent)`,
      outline: 'none',
    },
    formSelect: {
      width: '100%',
      padding: '10px 12px',
      border: `1px solid ${t.border}`,
      borderRadius: '8px',
      backgroundColor: t.surface,
      color: t.text,
      fontSize: '14px',
      boxSizing: 'border-box' as const,
      cursor: 'pointer',
    },
    formHint: {
      fontSize: '12px',
      color: t.textSecondary,
      marginTop: '4px',
    },
    formActions: {
      display: 'flex' as const,
      gap: '10px',
      justifyContent: 'flex-end' as const,
      marginTop: '24px',
      paddingTop: '16px',
      borderTop: `1px solid ${t.border}`,
    },

    // ── Buttons ───────────────────────────────────────────────────────────────
    btn: {
      display: 'inline-flex' as const,
      alignItems: 'center' as const,
      gap: '6px',
      padding: '10px 20px',
      border: 'none',
      borderRadius: '8px',
      fontSize: '14px',
      fontWeight: 500,
      cursor: 'pointer',
      transition: 'background 0.15s ease, border-color 0.15s ease',
    },
    btnPrimary: {
      background: t.accentGradient,
      color: 'var(--pf-color-text-on-primary)',
    },
    btnSecondary: {
      backgroundColor: 'transparent',
      color: t.textSecondary,
      border: `1px solid ${t.border}`,
    },
    btnSuccess: {
      backgroundColor: t.success,
      color: 'var(--pf-color-text-on-success)',
    },
    btnDisabled: {
      opacity: 0.6,
      cursor: 'not-allowed',
    },

    // ── Tuning / test ─────────────────────────────────────────────────────────
    tuningToggle: {
      display: 'flex' as const,
      alignItems: 'center' as const,
      gap: '8px',
      cursor: 'pointer',
      fontSize: '13px',
      fontWeight: 500,
      color: t.textSecondary,
      padding: '8px 0',
      userSelect: 'none' as const,
    },
    testResult: {
      marginTop: '12px',
      padding: '10px 14px',
      borderRadius: '8px',
      fontSize: '13px',
    },

    // ── Type grid (provider type selector) ───────────────────────────────────
    typeGrid: {
      display: 'grid' as const,
      gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
      gap: '8px',
    },
    typeCard: {
      padding: '10px 8px',
      borderRadius: '8px',
      border: `1px solid ${t.border}`,
      backgroundColor: t.surface,
      cursor: 'pointer',
      textAlign: 'center' as const,
      transition: 'background 0.15s ease, border-color 0.15s ease',
    },
    typeCardSelected: {
      border: `2px solid ${t.accent}`,
      boxShadow: `0 0 0 2px color-mix(in srgb, ${t.accent} 20%, transparent)`,
    },
    typeCardDisabled: {
      opacity: 0.4,
      cursor: 'not-allowed',
    },
    typeCardIcon: {
      fontSize: '20px',
      marginBottom: '4px',
    },
    typeCardLabel: {
      fontSize: '11px',
      color: t.textSecondary,
      overflow: 'hidden' as const,
      textOverflow: 'ellipsis' as const,
      whiteSpace: 'nowrap' as const,
    },
    typeCardCategory: {
      fontSize: '10px',
      color: t.textMuted,
      marginTop: '2px',
    },

    // ── Accordion ─────────────────────────────────────────────────────────────
    accordionSection: {
      borderRadius: '8px',
      border: `1px solid ${t.border}`,
      overflow: 'hidden' as const,
      marginBottom: '8px',
    },
    accordionHeader: {
      display: 'flex' as const,
      alignItems: 'center' as const,
      gap: '10px',
      padding: '12px 14px',
      cursor: 'pointer',
      backgroundColor: t.surface,
      transition: 'background 0.15s ease',
    },
    accordionHeaderLeft: {
      display: 'flex' as const,
      alignItems: 'center' as const,
      gap: '8px',
      flex: 1,
    },
    accordionDot: {
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      flexShrink: 0,
    },
    accordionDotComplete: {
      backgroundColor: t.accent,
    },
    accordionDotPending: {
      backgroundColor: t.border,
    },
    accordionDotError: {
      backgroundColor: t.error,
    },
    accordionTitle: {
      fontSize: '14px',
      fontWeight: 500,
      color: t.text,
    },
    accordionChevron: {
      fontSize: '10px',
      color: t.textMuted,
      transition: 'transform 0.2s ease',
    },
    accordionBody: {
      padding: '12px 14px',
      backgroundColor: t.bg,
      borderTop: `1px solid ${t.border}`,
    },

    // ── Quick switcher ────────────────────────────────────────────────────────
    switcherContainer: {
      minWidth: 0,
      flexShrink: 1,
      display: 'inline-flex' as const,
      alignItems: 'center' as const,
      gap: '8px',
      position: 'relative' as const,
    },
    switcherBtn: {
      minWidth: 0,
      maxWidth: '100%',
      display: 'inline-flex' as const,
      alignItems: 'center' as const,
      gap: '4px',
      padding: '4px 8px',
      border: 'none',
      borderRadius: '6px',
      fontSize: '12px',
      cursor: 'pointer',
      backgroundColor: 'transparent',
      color: t.textSecondary,
      transition: 'background 0.15s ease, color 0.15s ease',
      whiteSpace: 'nowrap' as const,
    },
    switcherDropdown: {
      position: 'absolute' as const,
      bottom: '100%',
      right: 0,
      marginBottom: '6px',
      minWidth: '220px',
      backgroundColor: t.bg,
      border: `1px solid ${t.border}`,
      borderRadius: '10px',
      boxShadow: '0 -4px 20px rgba(0, 0, 0, 0.3)',
      zIndex: 1000,
      overflow: 'hidden' as const,
    },
    switcherItem: {
      display: 'flex' as const,
      alignItems: 'center' as const,
      gap: '10px',
      padding: '10px 14px',
      cursor: 'pointer',
      fontSize: '13px',
      transition: 'background 0.1s ease',
      color: t.text,
    },
    switcherItemActive: {
      borderLeft: `3px solid ${t.accent}`,
      backgroundColor: `color-mix(in srgb, ${t.accent} 8%, transparent)`,
    },
    switcherToast: {
      position: 'fixed' as const,
      bottom: '16px',
      right: '16px',
      padding: '10px 16px',
      borderRadius: '8px',
      backgroundColor: t.surface,
      border: `1px solid ${t.border}`,
      color: t.text,
      fontSize: '13px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
      zIndex: 9999,
    },

    // ── Status dots ───────────────────────────────────────────────────────────
    activeDot: {
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      backgroundColor: t.accent,
      flexShrink: 0,
    },
    healthDot: {
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      flexShrink: 0,
    },
    healthPassed: {
      backgroundColor: t.success,
    },
    healthFailed: {
      backgroundColor: t.error,
    },
    healthUntested: {
      backgroundColor: t.textMuted,
    },

    // ── Effective config section ──────────────────────────────────────────────
    effectiveSection: {
      marginTop: '16px',
      padding: '14px',
      borderRadius: '8px',
      backgroundColor: t.surface,
      border: `1px solid ${t.border}`,
    },
    effectiveHeader: {
      display: 'flex' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
    },
    effectiveRow: {
      display: 'flex' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
      padding: '6px 0',
      borderBottom: `1px solid ${t.border}`,
      fontSize: '13px',
    },
    effectiveKey: {
      color: t.textSecondary,
      fontFamily: 'monospace',
    },
    effectiveValue: {
      color: t.text,
      fontFamily: 'monospace',
      fontWeight: 500,
    },
    effectiveEyeBtn: {
      padding: '2px 6px',
      border: 'none',
      background: 'transparent',
      cursor: 'pointer',
      color: t.textMuted,
      fontSize: '14px',
    },
  };
}

export type StyleMap = ReturnType<typeof STYLES>;
