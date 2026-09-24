/**
 * The four GraphQL query strings this package sends — nothing else lives here.
 *
 * `POOLS_QUERY` and `PAIR_BY_ID_QUERY` are copied field-for-field from
 * the production AMM client's own `GetPools`/`GetPairById` documents — every
 * deployed subgraph indexes the identical SnF v2 schema, so there is no per-chain
 * branching. `_meta` is added to both (not present in that source) because
 * every `SubgraphTransport` method returns a `CachedResult`, which always needs its own
 * freshness — see `subgraph.ts`'s `gradeFreshness`.
 *
 * `POOL_INVENTORY_QUERY` is copied verbatim from a sibling SnF product's own
 * `PoolInventory` document. `currency(id:...)` and `_meta` are selected in the SAME
 * document on purpose: asking for the ids and the index's own block in two
 * separate requests would let a freshness line describe a different moment than the
 * data it labels.
 *
 * `META_QUERY` is new — a standalone health probe with no entity payload.
 */

export const POOLS_QUERY = /* GraphQL */ `
  query GetPools($first: Int!, $skip: Int) {
    pairs(
      first: $first
      skip: $skip
      orderBy: reserveUSD
      orderDirection: desc
    ) {
      id
      discrete0
      discrete1
      isNFTPool
      token0 {
        id
        symbol
        name
        decimals
        collection {
          id
          name
          symbol
          wrapper { id }
        }
      }
      token1 {
        id
        symbol
        name
        decimals
        collection {
          id
          name
          symbol
          wrapper { id }
        }
      }
      reserve0
      reserve1
      totalSupply
      reserveETH
      reserveUSD
      volumeToken0
      volumeToken1
      volumeUSD
      txCount
      createdAtTimestamp
      createdAtBlockNumber
    }
    _meta {
      block { number timestamp }
      hasIndexingErrors
    }
  }
`

export const PAIR_BY_ID_QUERY = /* GraphQL */ `
  query GetPairById($id: ID!) {
    pair(id: $id) {
      id
      discrete0
      discrete1
      isNFTPool
      reserve0
      reserve1
      totalSupply
      reserveETH
      reserveUSD
      volumeToken0
      volumeToken1
      volumeUSD
      txCount
      token0 {
        id
        symbol
        name
        decimals
        collection {
          id
          name
          symbol
          wrapper { id }
        }
      }
      token1 {
        id
        symbol
        name
        decimals
        collection {
          id
          name
          symbol
          wrapper { id }
        }
      }
    }
    _meta {
      block { number timestamp }
      hasIndexingErrors
    }
  }
`

export const POOL_INVENTORY_QUERY = /* GraphQL */ `
  query PoolInventory($wrapper: ID!) {
    currency(id: $wrapper) {
      id
      symbol
      name
      decimals
      wrapping
      tokenIds
      collection {
        id
        name
        symbol
      }
    }
    _meta {
      block {
        number
        timestamp
      }
      hasIndexingErrors
    }
  }
`

export const META_QUERY = /* GraphQL */ `
  query SnfMeta {
    _meta {
      block { number timestamp }
      hasIndexingErrors
    }
  }
`
