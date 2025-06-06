const superagent = require('superagent');
const { request, gql } = require('graphql-request');
const sdk = require('@defillama/sdk');

const utils = require('../utils');
const { aTokenAbi } = require('../aave-v3/abi');
const poolAbi = require('../aave-v3/poolAbi');

const SECONDS_PER_YEAR = 31536000;

const chainUrlParam = {
  linea: ['proto_linea_v3'],
  ethereum: [
    'proto_mainnet_lrt_v3',
    'proto_mainnet_btc_v3',
    'proto_mainnet_rwa_v3',
  ],
  era: ['proto_zksync_era_v3'],
  blast: ['proto_blast_v3'],
  manta: ['proto_manta_v3'],
  xlayer: ['proto_layerx_v3'],
  base: ['proto_base_v3'],
};

const mainnnet_pools = {
  '0x3bc3d34c32cc98bf098d832364df8a222bbab4c0': 'proto_mainnet_lrt_v3',
  '0xcd2b31071119d7ea449a9d211ac8ebf7ee97f987': 'proto_mainnet_btc_v3',
  '0xd3a4da66ec15a001466f324fa08037f3272bdbe8': 'proto_mainnet_rwa_v3',
};
const oraclePriceABI = {
  inputs: [
    {
      internalType: 'address',
      name: 'asset',
      type: 'address',
    },
  ],
  name: 'getAssetPrice',
  outputs: [
    {
      internalType: 'uint256',
      name: '',
      type: 'uint256',
    },
  ],
  stateMutability: 'view',
  type: 'function',
};

const getPrices = async (addresses) => {
  const _prices = (
    await superagent.get(
      `https://coins.llama.fi/prices/current/${addresses
        .join(',')
        .toLowerCase()}`
    )
  ).body.coins;

  const zeroPrice = (
    await sdk.api.abi.call({
      target: '0x1cc993f2C8b6FbC43a9bafd2A44398E739733385',
      abi: oraclePriceABI,
      params: ['0x3db28e471fa398bf2527135a1c559665941ee7a3'],
      chain: 'ethereum',
    })
  ).output;

  const earlyZero = {
    'era:0x9793eac2fecef55248efa039bec78e82ac01cb2f': {
      decimals: 18,
      symbol: 'earlyZERO',
      price: Number(zeroPrice) / 1e8,
      timestamp: Date.now(),
      confidence: 0.99,
    },
    'linea:0x40a59a3f3b16d9e74c811d24d8b7969664cfe180': {
      decimals: 18,
      symbol: 'earlyZERO',
      price: Number(zeroPrice) / 1e8,
      timestamp: Date.now(),
      confidence: 0.99,
    },
    'ethereum:0x3db28e471fa398bf2527135a1c559665941ee7a3': {
      decimals: 18,
      symbol: 'earlyZERO',
      price: Number(zeroPrice) / 1e8,
      timestamp: Date.now(),
      confidence: 0.99,
    },
  };

  const prices = { ..._prices, ...earlyZero };

  const pricesBySymbol = Object.entries(prices).reduce(
    (acc, [name, price]) => ({
      ...acc,
      [price.symbol.toLowerCase()]: price.price,
    }),
    {}
  );

  const pricesByAddress = Object.entries(prices).reduce(
    (acc, [name, price]) => ({
      ...acc,
      [name.split(':')[1]]: price.price,
    }),
    {}
  );

  return { pricesByAddress, pricesBySymbol };
};

const baseUrl =
  'https://api.goldsky.com/api/public/project_clsk1wzatdsls01wchl2e4n0y/subgraphs/';
const API_URLS = {
  ethereum: [
    baseUrl + 'zerolend-mainnet-lrt/1.0.0/gn',
    baseUrl + 'zerolend-mainnet-btc/1.0.0/gn',
    baseUrl + 'zerolend-mainnet-rwa/1.0.1/gn',
  ],
  linea: [baseUrl + 'zerolend-linea/1.0.0/gn'],
  era: [baseUrl + 'zerolend-zksync/1.0.0/gn'],
  manta: [baseUrl + 'zerolend-m/1.0.0/gn'],
  blast: [baseUrl + 'zerolend-blast/1.0.1/gn'],
  xlayer: [baseUrl + 'zerolend-xlayer/1.0.0/gn'],
  base: [baseUrl + 'zerolend-base-mainnet/1.0.0/gn'],
};

const query = gql`
  query ReservesQuery {
    reserves(where: { name_not: "" }) {
      name
      borrowingEnabled
      pool {
        pool
      }
      aToken {
        id
        rewards {
          id
          emissionsPerSecond
          rewardToken
          rewardTokenDecimals
          rewardTokenSymbol
          distributionEnd
        }
        underlyingAssetAddress
        underlyingAssetDecimals
      }
      vToken {
        rewards {
          emissionsPerSecond
          rewardToken
          rewardTokenDecimals
          rewardTokenSymbol
          distributionEnd
        }
      }
      symbol
      liquidityRate
      variableBorrowRate
      baseLTVasCollateral
      isFrozen
    }
  }
`;

const apy = async () => {
  let data = await Promise.all(
    Object.entries(API_URLS).flatMap(([chain, urls]) => {
      return urls.map(async (url) => [
        chain,
        (await request(url, query)).reserves,
      ]);
    })
  );

  data = data.map(([chain, reserves]) => [
    chain,
    reserves.filter((p) => !p.isFrozen),
  ]);

  const totalSupply = await Promise.all(
    data.map(async ([chain, reserves]) =>
      (
        await sdk.api.abi.multiCall({
          chain: chain,
          abi: aTokenAbi.find(({ name }) => name === 'totalSupply'),
          calls: reserves.map((reserve) => ({
            target: reserve.aToken.id,
          })),
        })
      ).output.map(({ output }) => output)
    )
  );

  const underlyingBalances = await Promise.all(
    data.map(async ([chain, reserves]) =>
      (
        await sdk.api.abi.multiCall({
          chain: chain,
          abi: aTokenAbi.find(({ name }) => name === 'balanceOf'),
          calls: reserves.map((reserve, i) => ({
            target: reserve.aToken.underlyingAssetAddress,
            params: [reserve.aToken.id],
          })),
        })
      ).output.map(({ output }) => output)
    )
  );

  const underlyingTokens = data.map(([chain, reserves]) =>
    reserves.map((pool) => `${chain}:${pool.aToken.underlyingAssetAddress}`)
  );

  const rewardTokens = data.map(([chain, reserves]) =>
    reserves.map((pool) =>
      pool.aToken.rewards.map((rew) => `${chain}:${rew.rewardToken}`)
    )
  );

  const allTokens = underlyingTokens.flat().concat(rewardTokens.flat(Infinity));
  const pricesByAddress = {};
  const pricesBySymbol = {};

  for (let i = 0; i < allTokens.length; i += 50) {
    const chunk = allTokens.slice(i, i + 50);
    const {
      pricesByAddress: chunkPricesByAddress,
      pricesBySymbol: chunkPricesBySymbol,
    } = await getPrices(chunk);
    Object.assign(pricesByAddress, chunkPricesByAddress);
    Object.assign(pricesBySymbol, chunkPricesBySymbol);
  }

  const pools = data.map(([chain, markets], i) => {
    const chainPools = markets.map((pool, idx) => {
      const supply = totalSupply[i][idx];
      const currentSupply = underlyingBalances[i][idx];
      const totalSupplyUsd =
        (supply / 10 ** pool.aToken.underlyingAssetDecimals) *
        (pricesByAddress[pool.aToken.underlyingAssetAddress] ||
          pricesBySymbol[pool.symbol]);
      const tvlUsd =
        (currentSupply / 10 ** pool.aToken.underlyingAssetDecimals) *
        (pricesByAddress[pool.aToken.underlyingAssetAddress] ||
          pricesBySymbol[pool.symbol]);
      const { rewards } = pool.aToken;

      const rewardPerYear = rewards.reduce(
        (acc, rew) =>
          acc +
          (rew.emissionsPerSecond / 10 ** rew.rewardTokenDecimals) *
            SECONDS_PER_YEAR *
            (pricesByAddress[rew.rewardToken] ||
              pricesBySymbol[rew.rewardTokenSymbol] ||
              0),
        0
      );

      const { rewards: rewardsBorrow } = pool.vToken;
      const rewardPerYearBorrow = rewardsBorrow.reduce(
        (acc, rew) =>
          acc +
          (rew.emissionsPerSecond / 10 ** rew.rewardTokenDecimals) *
            SECONDS_PER_YEAR *
            (pricesByAddress[rew.rewardToken] ||
              pricesBySymbol[rew.rewardTokenSymbol] ||
              0),
        0
      );
      let totalBorrowUsd = totalSupplyUsd - tvlUsd;
      totalBorrowUsd = totalBorrowUsd < 0 ? 0 : totalBorrowUsd;

      const supplyRewardEnd = pool.aToken.rewards[0]?.distributionEnd;
      const borrowRewardEnd = pool.vToken.rewards[0]?.distributionEnd;

      return {
        pool: `${pool.aToken.id}-${chain}`.toLowerCase(),
        chain: utils.formatChain(chain),
        project: 'zerolend',
        symbol: pool.symbol,
        tvlUsd,
        apyBase: (pool.liquidityRate / 10 ** 27) * 100,
        apyReward:
          supplyRewardEnd * 1000 > new Date()
            ? (rewardPerYear / totalSupplyUsd) * 100
            : null,
        rewardTokens:
          supplyRewardEnd * 1000 > new Date()
            ? rewards.map((rew) => rew.rewardToken)
            : null,
        underlyingTokens: [pool.aToken.underlyingAssetAddress],
        totalSupplyUsd,
        totalBorrowUsd,
        apyBaseBorrow: Number(pool.variableBorrowRate) / 1e25,
        apyRewardBorrow:
          borrowRewardEnd * 1000 > new Date()
            ? (rewardPerYearBorrow / totalBorrowUsd) * 100
            : null,
        ltv: Number(pool.baseLTVasCollateral) / 10000,
        url: `https://app.zerolend.xyz/reserve-overview/?underlyingAsset=${
          pool.aToken.underlyingAssetAddress
        }&marketName=${
          chain === 'ethereum' 
            ? mainnnet_pools[pool.pool.pool]
            : chainUrlParam[chain][0]
        }&utm_source=defillama&utm_medium=listing&utm_campaign=external`,
        borrowable: pool.borrowingEnabled,
      };
    });

    return chainPools;
  });

  return pools.flat().filter((p) => !!p.tvlUsd);
};

module.exports = { timetravel: false, apy };
