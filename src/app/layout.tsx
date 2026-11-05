import type { Metadata, Viewport } from 'next';
import type { ReactElement, ReactNode } from 'react';
import './globals.css';

/**
 * Root layout for KubeVision AI.
 *
 * SSR boundary: this file is a Server Component. It must never import
 * `three`, `@react-three/fiber`, `window`, or `Worker` directly - the WebGL
 * canvas is mounted through a client component loaded with
 * `next/dynamic({ ssr: false })` further down the tree.
 */

const siteTitle =
  'KubeVision AI | Cloud-Native 3D Situational Awareness & Copilot';

const siteDescription =
  'Real-time Kubernetes observability rendered as a navigable 3D cluster topology, with an on-device AI copilot for anomaly triage and root-cause reasoning.';

export const metadata: Metadata = {
  title: {
    default: siteTitle,
    template: '%s | KubeVision AI',
  },
  description: siteDescription,
  applicationName: 'KubeVision AI',
  keywords: [
    'Kubernetes',
    'observability',
    'cloud-native',
    '3D visualization',
    'WebGL',
    'AI copilot',
    'SRE',
    'situational awareness',
  ],
  authors: [{ name: 'KubeVision AI' }],
  creator: 'KubeVision AI',
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    type: 'website',
    title: siteTitle,
    description: siteDescription,
    siteName: 'KubeVision AI',
  },
  twitter: {
    card: 'summary_large_image',
    title: siteTitle,
    description: siteDescription,
  },
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#020617',
  colorScheme: 'dark',
};

interface RootLayoutProps {
  children: ReactNode;
}

export default function RootLayout({
  children,
}: RootLayoutProps): ReactElement {
  return (
    <html lang="zh-CN" className="dark h-full overflow-hidden" suppressHydrationWarning>
      {/* `overflow-hidden` on both html and body is what makes the shell's
          100dvh lock actually hold: without it, any 1px overshoot in a child
          pane produces a document scrollbar and the fixed 65/35 split starts
          drifting. Per-pane scrolling is opted into individually. */}
      <body className="h-full overflow-hidden bg-slate-950 text-slate-100 antialiased selection:bg-cyan-500/30 selection:text-cyan-50">
        <div className="relative flex h-full flex-col overflow-hidden bg-slate-950 text-slate-100 antialiased">
          {children}
        </div>
      </body>
    </html>
  );
}
