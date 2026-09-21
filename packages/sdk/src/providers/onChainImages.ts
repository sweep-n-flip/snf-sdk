import { ERC721_ABI } from '../abis/ERC721'
import { assertParam } from '../errors'
import { parseTokenUri } from './tokenUriParse'
import type { ImagesProvider, ImagesProviderContext } from '../types/providers.types'

/**
 * The keyless default `ImagesProvider` (R19, D-06; 54-SPEC.md) — the only data source
 * this package ships that works, with no API key, on every one of the 14 chains. A
 * collection already carries its own artwork on-chain: `tokenURI(id)` is a public
 * read, and Multicall3 batches an entire request's worth of ids into ONE RPC call
 * (`enrichListingsWithOnChainTokenURI`'s pattern — `snf-client/src/lib/aggregator/
 * onChainTokenURI.ts` — read via the partner's own `publicClient`, never a keyed
 * indexer the SDK would have to pay for or gate).
 *
 * `onChainImagesProvider` is a stateless singleton object (module-scope `const`,
 * allowed under `local/no-module-global-state` — it holds no mutable state, no cache,
 * nothing that could leak across two clients on the same page; see that rule's own
 * doc comment). Each call supplies its own `ImagesProviderContext` (`publicClient` +
 * `chain`) rather than the provider being bound to one client at construction —
 * exactly why `resolveProviders` (`defaults.ts`) can hand back this same object as
 * EVERY client's default `images` provider without constructing anything per client.
 */
export const onChainImagesProvider: ImagesProvider = Object.freeze({
  async getImages(
    ctx: ImagesProviderContext,
    collection: `0x${string}`,
    tokenIds: readonly string[],
  ): Promise<Map<string, string | undefined>> {
    assertParam(tokenIds.length <= 50, 'getImages accepts at most 50 tokenIds per call', {
      field: 'tokenIds',
      count: tokenIds.length,
    })

    const map = new Map<string, string | undefined>()
    if (tokenIds.length === 0) return map

    // ONE multicall for the whole batch. `allowFailure: true` so a single reverting
    // id (or a collection that doesn't implement `tokenURI` at all) never loses the
    // rest of the batch — every failure maps to `undefined` for that id alone.
    const results = await ctx.publicClient.multicall({
      contracts: tokenIds.map((tokenId) => ({
        address: collection,
        abi: ERC721_ABI,
        functionName: 'tokenURI' as const,
        args: [BigInt(tokenId)] as const,
      })),
      allowFailure: true,
      multicallAddress: ctx.chain.multicall3,
      batchSize: 0,
    })

    tokenIds.forEach((tokenId, index) => {
      const result = results[index]
      if (!result || result.status !== 'success' || typeof result.result !== 'string') {
        map.set(tokenId, undefined)
        return
      }
      map.set(tokenId, parseTokenUri(result.result)?.image)
    })

    return map
  },
})
