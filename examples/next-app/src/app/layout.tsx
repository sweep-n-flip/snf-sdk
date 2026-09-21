import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Providers } from './providers'

export const metadata: Metadata = {
  title: '@sweepnflip/sdk — next-app example',
  description:
    "Discovery -> inventory -> quote -> checkout on one page, through @sweepnflip/sdk-react's public hooks.",
}

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, -apple-system, sans-serif',
          margin: 0,
          padding: 24,
          background: '#0b0d10',
          color: '#e6e6e6',
        }}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
