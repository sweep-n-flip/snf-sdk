import type { PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { getChain } from '../../src/chains/registry'
import { isSnfError } from '../../src/errors'
import { NO_PROVIDER, resolveProviders } from '../../src/providers/defaults'
import { onChainImagesProvider } from '../../src/providers/onChainImages'
import { parseTokenUri } from '../../src/providers/tokenUriParse'
import type { ImagesProviderContext } from '../../src/types/providers.types'
import type { SnfClientConfig } from '../../src/types/client.types'

/**
 * `resolveProviders` and the keyless `onChainImagesProvider` default.
 * Every `<behavior>` bullet of this module's Task 2 is one `it` below.
 */

const BASE_CHAIN_ID = 8453
const COLLECTION = '0x00000000000000000000000000000000000c011' as `0x${string}`

function fakeConfig(overrides: Partial<SnfClientConfig> = {}): SnfClientConfig {
  return {
    chainId: BASE_CHAIN_ID,
    publicClient: {} as PublicClient,
    ...overrides,
  }
}

interface MulticallCall {
  status: 'success' | 'failure'
  result?: string
}

function fakeImagesCtx(multicallImpl: (args: unknown) => Promise<MulticallCall[]>): {
  ctx: ImagesProviderContext
  multicall: ReturnType<typeof vi.fn>
} {
  const multicall = vi.fn(multicallImpl)
  const ctx = {
    publicClient: { multicall } as unknown as PublicClient,
    chain: getChain(BASE_CHAIN_ID),
  }
  return { ctx, multicall }
}

const DATA_JSON_BASE64_SVG = `data:application/json;base64,${btoa(
  JSON.stringify({ name: 'Item #1', image: 'data:image/svg+xml;base64,PHN2Zy8+' }),
)}`

describe('resolveProviders — defaults + partner overrides', () => {
  it('resolveProviders({}) returns the on-chain default for images and NO_PROVIDER for the other three', () => {
    const resolved = resolveProviders(fakeConfig())
    expect(resolved.images).toBe(onChainImagesProvider)
    expect(resolved.walletNfts).toBe(NO_PROVIDER)
    expect(resolved.prices).toBe(NO_PROVIDER)
    expect(resolved.poolInventory).toBe(NO_PROVIDER)
  })

  it('a partner-supplied provider overrides the default for that key only', () => {
    const customImages = { getImages: vi.fn() }
    const resolved = resolveProviders(fakeConfig({ providers: { images: customImages } }))
    expect(resolved.images).toBe(customImages)
    expect(resolved.walletNfts).toBe(NO_PROVIDER)
    expect(resolved.prices).toBe(NO_PROVIDER)
    expect(resolved.poolInventory).toBe(NO_PROVIDER)
  })

  it('calling a NO_PROVIDER surface resolves to undefined — never throws, never fetches, never returns []', async () => {
    await expect(NO_PROVIDER.getWalletNfts('0x1' as `0x${string}`, '0x2' as `0x${string}`, 1)).resolves.toBeUndefined()
    await expect(NO_PROVIDER.getNativeUsd(1)).resolves.toBeUndefined()
    await expect(NO_PROVIDER.getPoolInventory('0x1' as `0x${string}`, 1)).resolves.toBeUndefined()
  })
})

describe('onChainImagesProvider.getImages — keyless Multicall3 default', () => {
  it('issues exactly ONE publicClient.multicall for a batch, with allowFailure:true and batchSize:0', async () => {
    const { ctx, multicall } = fakeImagesCtx(() =>
      Promise.resolve([
        { status: 'success', result: DATA_JSON_BASE64_SVG },
        { status: 'failure' },
      ]),
    )

    const map = await onChainImagesProvider.getImages(ctx, COLLECTION, ['1', '2'])

    expect(multicall).toHaveBeenCalledTimes(1)
    const callArgs = multicall.mock.calls[0]?.[0] as {
      allowFailure: boolean
      batchSize: number
      multicallAddress: string
      contracts: readonly unknown[]
    }
    expect(callArgs.allowFailure).toBe(true)
    expect(callArgs.batchSize).toBe(0)
    expect(callArgs.multicallAddress).toBe(getChain(BASE_CHAIN_ID).multicall3)
    expect(callArgs.contracts).toHaveLength(2)
    expect(map).toBeInstanceOf(Map)
  })

  it('a data:application/json;base64 tokenURI yields the decoded image field', async () => {
    const { ctx } = fakeImagesCtx(() =>
      Promise.resolve([{ status: 'success', result: DATA_JSON_BASE64_SVG }]),
    )
    const map = await onChainImagesProvider.getImages(ctx, COLLECTION, ['1'])
    expect(map.get('1')).toBe('data:image/svg+xml;base64,PHN2Zy8+')
  })

  it('an ipfs:// tokenURI yields the ipfs://-preserving value, unresolved to any gateway', async () => {
    const { ctx } = fakeImagesCtx(() =>
      Promise.resolve([{ status: 'success', result: 'ipfs://bafybeigd/1.json' }]),
    )
    const map = await onChainImagesProvider.getImages(ctx, COLLECTION, ['1'])
    expect(map.get('1')).toBe('ipfs://bafybeigd/1.json')
  })

  it('a reverting tokenURI (status: failure) yields undefined for that id and never throws for the batch', async () => {
    const { ctx } = fakeImagesCtx(() => Promise.resolve([{ status: 'failure' }, { status: 'success', result: DATA_JSON_BASE64_SVG }]))
    const map = await onChainImagesProvider.getImages(ctx, COLLECTION, ['1', '2'])
    expect(map.get('1')).toBeUndefined()
    expect(map.get('2')).toBeDefined()
  })

  it('an empty-string tokenURI yields undefined for that id', async () => {
    const { ctx } = fakeImagesCtx(() => Promise.resolve([{ status: 'success', result: '' }]))
    const map = await onChainImagesProvider.getImages(ctx, COLLECTION, ['1'])
    expect(map.get('1')).toBeUndefined()
  })

  it('unparseable JSON in a data: tokenURI yields undefined, never throws', async () => {
    const { ctx } = fakeImagesCtx(() =>
      Promise.resolve([{ status: 'success', result: 'data:application/json;base64,bm90LWpzb24=' }]),
    )
    const map = await onChainImagesProvider.getImages(ctx, COLLECTION, ['1'])
    expect(map.get('1')).toBeUndefined()
  })

  it('a collection with no tokenURI at all (every id fails) yields all-undefined with no throw', async () => {
    const { ctx } = fakeImagesCtx(() => Promise.resolve([{ status: 'failure' }, { status: 'failure' }]))
    const map = await onChainImagesProvider.getImages(ctx, COLLECTION, ['1', '2'])
    expect(map.get('1')).toBeUndefined()
    expect(map.get('2')).toBeUndefined()
    expect(map.size).toBe(2)
  })

  it('rejects with SnfError(INVALID_PARAMS) for more than 50 tokenIds', async () => {
    const { ctx } = fakeImagesCtx(() => Promise.resolve([]))
    const tokenIds = Array.from({ length: 51 }, (_, i) => String(i))
    await expect(onChainImagesProvider.getImages(ctx, COLLECTION, tokenIds)).rejects.toSatisfy(
      (e: unknown) => isSnfError(e) && e.code === 'INVALID_PARAMS',
    )
  })

  it('an empty tokenIds array short-circuits to an empty Map with zero multicall calls', async () => {
    const { ctx, multicall } = fakeImagesCtx(() => Promise.resolve([]))
    const map = await onChainImagesProvider.getImages(ctx, COLLECTION, [])
    expect(map.size).toBe(0)
    expect(multicall).not.toHaveBeenCalled()
  })
})

describe('parseTokenUri — pure, no fetch', () => {
  it('decodes a data:application/json;base64 document', () => {
    const parsed = parseTokenUri(DATA_JSON_BASE64_SVG)
    expect(parsed?.image).toBe('data:image/svg+xml;base64,PHN2Zy8+')
    expect(parsed?.name).toBe('Item #1')
  })

  it('decodes a data:application/json, URL-encoded document', () => {
    const doc = encodeURIComponent(JSON.stringify({ image: 'https://example.test/1.png' }))
    const parsed = parseTokenUri(`data:application/json,${doc}`)
    expect(parsed?.image).toBe('https://example.test/1.png')
  })

  it('passes an ipfs:// URI through unresolved', () => {
    expect(parseTokenUri('ipfs://bafybeigd/1.json')?.image).toBe('ipfs://bafybeigd/1.json')
  })

  it('returns undefined for an empty string', () => {
    expect(parseTokenUri('')).toBeUndefined()
  })

  it('returns undefined for an unrecognised scheme', () => {
    expect(parseTokenUri('javascript:alert(1)')).toBeUndefined()
  })
})
