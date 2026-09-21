import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import forkChains from './chains.fork.json'

/**
 * The anvil fork harness (Task 1, R20; 54-SPEC.md). Explicit binary resolution,
 * pinned fork blocks, one isolated port per lane, Windows-safe shutdown.
 *
 * Foundry's `anvil`/`forge` 1.5.1-stable IS installed on this dev host at
 * `~/.foundry/bin/` but is **NOT on PATH** (confirmed this session — see
 * `snf-54-RESEARCH.md` § "Environment Availability"). CI installs it via the
 * `foundry-rs/foundry-toolchain` action instead of assuming a PATH entry.
 */

export interface ForkLaneFixture {
  readonly [key: string]: unknown
}

export interface ForkLaneConfig {
  readonly key: string
  readonly chainId: number
  readonly rpcEnvVar: string
  readonly fallbackRpcUrl: string
  readonly forkBlockNumber: number | null
  readonly observedHeadAtCapture: number
  readonly observedDate: string
  readonly port: number
  readonly nonDeterministic: boolean
  readonly requiresUserAgent?: string
  readonly note: string
  readonly fixtures: ForkLaneFixture
}

export const FORK_LANES = forkChains as readonly ForkLaneConfig[]

/** Every lane's port, in `chains.fork.json` order — `isolation.fork.test.ts` asserts
 * these are pairwise distinct (the R20 backstop edge). */
export const FORK_PORTS: readonly number[] = FORK_LANES.map((l) => l.port)

function isWin32(): boolean {
  return process.platform === 'win32'
}

/**
 * Resolves the local `anvil` executable, in order:
 *   1. `process.env.ANVIL_BIN` (explicit override — CI or a dev with a nonstandard install)
 *   2. `anvil`/`anvil.exe` on `PATH` (works once `foundryup` or the `foundry-toolchain`
 *      GH Action has run)
 *   3. the documented Windows install path `~/.foundry/bin/anvil.exe`
 *   4. the POSIX install path `~/.foundry/bin/anvil`
 * Returns `undefined` when none of the four resolves to an existing, executable file
 * — callers must skip loudly (never throw an opaque spawn error) when this happens.
 */
export function resolveAnvilBinary(): string | undefined {
  const envBin = process.env['ANVIL_BIN']
  if (envBin && existsSync(envBin)) return envBin

  // PATH lookup: rely on the OS shell to resolve a bare command name — `spawnSync`
  // with `shell: true` would work, but we want a real path to log, not just "found
  // on PATH". `which`/`where` differ per platform, so try both known binary names
  // against every PATH entry directly (no shell dependency, no extra process).
  const pathEntries = (process.env['PATH'] ?? process.env['Path'] ?? '').split(isWin32() ? ';' : ':')
  const candidateNames = isWin32() ? ['anvil.exe', 'anvil.cmd'] : ['anvil']
  for (const dir of pathEntries) {
    if (!dir) continue
    for (const name of candidateNames) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }

  const foundryDir = join(homedir(), '.foundry', 'bin')
  const windowsPath = join(foundryDir, 'anvil.exe')
  if (existsSync(windowsPath)) return windowsPath
  const posixPath = join(foundryDir, 'anvil')
  if (existsSync(posixPath)) return posixPath

  return undefined
}

/** The message every lane's `describe.skip` prints when Foundry cannot be found —
 * names both remedies so a contributor without Foundry is never blocked and never
 * sees an opaque failure. */
export function anvilMissingMessage(): string {
  return (
    'anvil binary not found — fork lanes skipped. Fix with either: ' +
    '(1) set ANVIL_BIN=/path/to/anvil, or ' +
    "(2) run `foundryup` to install Foundry and put it on PATH. " +
    `Documented install location: ${join(homedir(), '.foundry', 'bin')}`
  )
}

export interface AnvilInstance {
  readonly url: string
  readonly chainId: number
  readonly port: number
  readonly accounts: readonly `0x${string}`[]
  stop(): Promise<void>
}

interface JsonRpcResponse<T> {
  readonly result?: T
  readonly error?: { readonly message: string }
}

async function rpcCall<T>(url: string, method: string, params: readonly unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await res.json()) as JsonRpcResponse<T>
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`)
  if (body.result === undefined) throw new Error(`${method} returned no result`)
  return body.result
}

/** Kills the anvil process tree. On Windows a plain `child.kill()` can orphan the
 * spawned child (anvil forks its own worker threads/processes for the fork RPC
 * client) — `taskkill /pid <pid> /T /F` kills the whole tree. POSIX gets a plain
 * `SIGKILL`, which is sufficient since anvil does not itself fork subprocesses on
 * POSIX. */
async function killProcessTree(pid: number): Promise<void> {
  if (isWin32()) {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
      killer.on('exit', () => resolve())
      killer.on('error', () => resolve())
    })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // already dead
  }
}

/** Polls `eth_blockNumber` until the anvil instance answers or the timeout elapses.
 * A fresh fork can take a few seconds to fetch the block header + full state it
 * needs before it will answer RPC calls at all. */
async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await rpcCall<string>(url, 'eth_blockNumber')
      return
    } catch (err) {
      lastError = err
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error(`anvil at ${url} did not become ready within ${timeoutMs}ms: ${String(lastError)}`)
}

/**
 * Starts one anvil fork for `lane`, on `lane.port`, pinned to `lane.forkBlockNumber`
 * unless the lane is `nonDeterministic` (forks `latest` instead — Robinhood's
 * documented non-archive-node caveat, see `chains.fork.json`). Waits up to 60s for
 * readiness (`eth_blockNumber` polling) and returns the anvil-provided dev accounts.
 */
export async function startAnvil(lane: ForkLaneConfig): Promise<AnvilInstance> {
  const bin = resolveAnvilBinary()
  if (!bin) throw new Error(anvilMissingMessage())

  const rpcUrl = process.env[lane.rpcEnvVar] || lane.fallbackRpcUrl
  const url = `http://127.0.0.1:${lane.port}`

  const args = [
    '--fork-url',
    rpcUrl,
    '--port',
    String(lane.port),
    '--chain-id',
    String(lane.chainId),
    '--accounts',
    '10',
    '--silent',
  ]
  if (!lane.nonDeterministic && lane.forkBlockNumber !== null) {
    args.push('--fork-block-number', String(lane.forkBlockNumber))
  }
  if (lane.requiresUserAgent) {
    args.push('--fork-header', `User-Agent: ${lane.requiresUserAgent}`)
  }

  const child = spawn(bin, args, { stdio: 'ignore' })
  const pid = child.pid
  if (pid === undefined) throw new Error(`failed to spawn anvil for lane ${lane.key}`)

  let exited = false
  child.on('exit', () => {
    exited = true
  })

  try {
    await waitForReady(url, 60_000)
  } catch (err) {
    await killProcessTree(pid)
    throw err
  }
  if (exited) throw new Error(`anvil for lane ${lane.key} exited before becoming ready`)

  const chainIdHex = await rpcCall<string>(url, 'eth_chainId')
  const chainId = Number.parseInt(chainIdHex, 16)
  if (chainId !== lane.chainId) {
    await killProcessTree(pid)
    throw new Error(`anvil for lane ${lane.key} reports chainId ${chainId}, expected ${lane.chainId}`)
  }

  const accounts = await rpcCall<readonly `0x${string}`[]>(url, 'eth_accounts')

  return {
    url,
    chainId,
    port: lane.port,
    accounts,
    async stop() {
      await killProcessTree(pid)
    },
  }
}
