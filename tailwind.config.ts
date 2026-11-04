import type { Config } from 'tailwindcss';

/**
 * KubeVision AI - Deep Space Cyber-Ops Design Tokens
 *
 * Palette contract (from .cursorrules):
 *   surface  -> bg-slate-950 / panel bg-slate-900/75 + backdrop-blur-md + border-slate-800
 *   healthy  -> emerald-400
 *   elevated -> amber-400
 *   critical -> rose-500
 *   accent   -> cyan-400
 */
const config: Config = {
  darkMode: 'class',
  content: [
    './src/app/**/*.{ts,tsx,mdx}',
    './src/components/**/*.{ts,tsx,mdx}',
    './src/features/**/*.{ts,tsx,mdx}',
    './src/lib/**/*.{ts,tsx}',
    './src/hooks/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        /** Deep space background ramp - darker than slate, used for canvas & shells. */
        void: {
          950: '#020617',
          900: '#040a1a',
          850: '#070f22',
          800: '#0b1428',
          700: '#101c33',
        },
        /** Primary theme stream-light (流光) - cyan family. */
        cyber: {
          50: '#ecfeff',
          100: '#cffafe',
          200: '#a5f3fc',
          300: '#67e8f9',
          400: '#22d3ee',
          500: '#06b6d4',
          600: '#0891b2',
          700: '#0e7490',
          800: '#155e75',
          900: '#164e63',
        },
        /** Semantic telemetry states - never hardcode these hex values in components. */
        telemetry: {
          healthy: '#34d399',
          elevated: '#fbbf24',
          critical: '#f43f5e',
          degraded: '#fb923c',
          idle: '#64748b',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'Noto Sans SC',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          'Liberation Mono',
          'monospace',
        ],
        display: [
          'Space Grotesk',
          'Inter',
          'ui-sans-serif',
          'system-ui',
          'sans-serif',
        ],
      },
      letterSpacing: {
        'ultra-wide': '0.28em',
      },
      boxShadow: {
        'glow-cyan':
          '0 0 0 1px rgba(34, 211, 238, 0.22), 0 0 16px -2px rgba(34, 211, 238, 0.45), 0 0 48px -14px rgba(34, 211, 238, 0.38)',
        'glow-emerald':
          '0 0 0 1px rgba(52, 211, 153, 0.22), 0 0 16px -2px rgba(52, 211, 153, 0.45), 0 0 48px -14px rgba(52, 211, 153, 0.38)',
        'glow-rose':
          '0 0 0 1px rgba(244, 63, 94, 0.24), 0 0 16px -2px rgba(244, 63, 94, 0.5), 0 0 48px -14px rgba(244, 63, 94, 0.42)',
        'glow-amber':
          '0 0 0 1px rgba(251, 191, 36, 0.22), 0 0 16px -2px rgba(251, 191, 36, 0.45), 0 0 48px -14px rgba(251, 191, 36, 0.38)',
        'glow-inset-cyan':
          'inset 0 0 24px -6px rgba(34, 211, 238, 0.35), inset 0 1px 0 0 rgba(34, 211, 238, 0.12)',
        'glow-inset-rose':
          'inset 0 0 24px -6px rgba(244, 63, 94, 0.35), inset 0 1px 0 0 rgba(244, 63, 94, 0.12)',
        'panel':
          '0 1px 0 0 rgba(148, 163, 184, 0.06) inset, 0 24px 48px -32px rgba(2, 6, 23, 0.9)',
      },
      dropShadow: {
        'glow-cyan': '0 0 6px rgba(34, 211, 238, 0.55)',
        'glow-emerald': '0 0 6px rgba(52, 211, 153, 0.55)',
        'glow-rose': '0 0 6px rgba(244, 63, 94, 0.6)',
      },
      textShadow: {
        'glow-cyan': '0 0 12px rgba(34, 211, 238, 0.55)',
        'glow-emerald': '0 0 12px rgba(52, 211, 153, 0.55)',
        'glow-rose': '0 0 12px rgba(244, 63, 94, 0.6)',
      },
      backgroundImage: {
        'void-radial':
          'radial-gradient(circle at 50% 0%, rgba(34, 211, 238, 0.10), transparent 55%), radial-gradient(circle at 85% 15%, rgba(59, 130, 246, 0.08), transparent 50%), radial-gradient(circle at 10% 85%, rgba(16, 185, 129, 0.06), transparent 55%)',
        'stream-cyan':
          'linear-gradient(90deg, transparent, rgba(34, 211, 238, 0.65), transparent)',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { opacity: '0.55', filter: 'brightness(1)' },
          '50%': { opacity: '1', filter: 'brightness(1.35)' },
        },
        'scan-line': {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(1000%)' },
        },
        'stream': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'spin-slow': {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' },
        },
      },
      animation: {
        'pulse-glow': 'pulse-glow 2.8s ease-in-out infinite',
        'scan-line': 'scan-line 6s linear infinite',
        stream: 'stream 3.5s linear infinite',
        float: 'float 6s ease-in-out infinite',
        'fade-in-up': 'fade-in-up 0.45s ease-out both',
        'spin-slow': 'spin-slow 18s linear infinite',
      },
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      gridTemplateColumns: {
        'hud-12': 'repeat(12, minmax(0, 1fr))',
      },
    },
  },
  plugins: [],
};

export default config;
