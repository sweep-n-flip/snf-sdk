import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * This rule (`check_kind: lint-rule`, `check_rule:
 * local/no-signing-imports`) — THE BELT TO THE LINT RULE'S BRACES. This test
 * deliberately duplicates `local/no-signing-imports`: a lint rule is one
 * `eslint.config.js` edit or one inline `eslint-disable` comment away from being off.
 * This test cannot be silenced that way, and it ALSO covers `dist` — a re-export
 * cannot smuggle a signing symbol past a source-only scan. Two independent lines for
 * the prohibition the whole product's trust rests on.
 */

const BANNED_TOKENS: readonly string[] = [
  'viem/accounts',
  'createWalletClient',
  'WalletClient',
  'privateKeyToAccount',
  'mnemonicToAccount',
  'hdKeyToAccount',
  'signTransaction',
  'signTypedData',
  'sendTransaction',
  'sendRawTransaction',
  'privateKey',
  'mnemonic',
]

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '')
}

function scanDir(dir: string, extensions: readonly string[]): readonly { readonly file: string; readonly line: number; readonly token: string }[] {
  const hits: { readonly file: string; readonly line: number; readonly token: string }[] = []
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        const stripped = stripComments(readFileSync(full, 'utf8'))
        stripped.split('\n').forEach((line, i) => {
          for (const token of BANNED_TOKENS) {
            if (line.includes(token)) hits.push({ file: full, line: i + 1, token })
          }
        })
      }
    }
  }
  walk(dir)
  return hits
}

describe('no-signing-surface — src (packages/sdk/src, source-level, mirrors local/no-signing-imports)', () => {
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src')

  it('zero non-comment occurrences of any signing/custody token', () => {
    const hits = scanDir(srcDir, ['.ts', '.tsx'])
    expect(hits.map((h) => `${path.relative(srcDir, h.file)}:${h.line} [${h.token}]`)).toEqual([])
  })
})

describe('no-signing-surface — dist (packages/sdk/dist, build-output-level — a re-export cannot smuggle a signing symbol past a source-only scan)', () => {
  const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist')

  it('dist/index.js and dist/index.cjs exist (the verify command builds first) and carry zero signing/custody tokens', () => {
    const indexJs = path.join(distDir, 'index.js')
    const indexCjs = path.join(distDir, 'index.cjs')
    expect(existsSync(indexJs), `${indexJs} missing — run "pnpm -r build" before this test (Task 3's verify chain does)`).toBe(true)
    expect(existsSync(indexCjs), `${indexCjs} missing — run "pnpm -r build" before this test`).toBe(true)
    const hits = scanDir(distDir, ['.js', '.cjs'])
    expect(hits.map((h) => `${path.relative(distDir, h.file)}:${h.line} [${h.token}]`)).toEqual([])
  })
})

describe('no-signing-surface — package.json has no wallet/signing dependency', () => {
  it('packages/sdk/package.json declares no dependency or peer named after a known signing/wallet library', () => {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      readonly dependencies?: Record<string, string>
      readonly peerDependencies?: Record<string, string>
      readonly devDependencies?: Record<string, string>
    }
    const allDepNames = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]
    // `viem` itself is allowed (it is the calldata-encoding/decoding library this
    // whole package is built on, not a signer) — `wagmi`/`ethers`/`web3` (any wallet
    // orchestration layer) are what this asserts against; `devDependencies` may
    // legitimately include `viem` for typings without being a runtime dependency.
    const bannedDepNames = ['wagmi', 'ethers', 'web3', '@rainbow-me/rainbowkit', 'viem/accounts']
    const hits = allDepNames.filter((name) => bannedDepNames.includes(name))
    expect(hits).toEqual([])
  })
})

describe('no-signing-surface — the public config type cannot carry a signing object', () => {
  it('SnfClientConfig rejects a walletClient/signer/privateKey/account field (@ts-expect-error)', () => {
    // This is purely a compile-time assertion — SnfClientConfig has no `walletClient`,
    // `signer`, `privateKey` or `account` field, so assigning an object literal with
    // one is a type error (TypeScript's excess-property check). The runtime body
    // never executes anything meaningful; it only needs to type-check under
    // `tsc --noEmit` so a real regression (the field being added) fails CI.
    type Cfg = import('../../src/types/client.types').SnfClientConfig
    const assignSignerField = (): void => {
      // @ts-expect-error — `walletClient` is not a field of SnfClientConfig.
      const _withWalletClient: Cfg = { chainId: 8453, publicClient: {} as never, walletClient: {} as never }
      // @ts-expect-error — `signer` is not a field of SnfClientConfig.
      const _withSigner: Cfg = { chainId: 8453, publicClient: {} as never, signer: {} as never }
      // @ts-expect-error — `privateKey` is not a field of SnfClientConfig.
      const _withPrivateKey: Cfg = { chainId: 8453, publicClient: {} as never, privateKey: '0xdead' }
      // @ts-expect-error — `account` is not a field of SnfClientConfig.
      const _withAccount: Cfg = { chainId: 8453, publicClient: {} as never, account: {} as never }
      void _withWalletClient
      void _withSigner
      void _withPrivateKey
      void _withAccount
    }
    void assignSignerField
    expect(true).toBe(true)
  })
})
