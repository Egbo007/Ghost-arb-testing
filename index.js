const { ethers } = require('ethers');
const fetch = require('node-fetch');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONFIG
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const RPC_URL            = process.env.RPC_URL || 'https://mainnet.base.org';
const MIN_GAP_PERCENT    = parseFloat(process.env.MIN_GAP_PERCENT || '0.5'); // lowered: real gaps are 0.3-0.8%
const MIN_LIQUIDITY_USD  = parseFloat(process.env.MIN_LIQUIDITY_USD || '10000'); // lowered: more pools pass
const SCAN_INTERVAL_MS   = parseInt(process.env.SCAN_INTERVAL_MS || '120000'); // 2min: scans take 90s+

const provider = new ethers.JsonRpcProvider(RPC_URL);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LIVE PRICE REFERENCES
// Updated each scan cycle from on-chain pools
// Used to convert non-stablecoin profits to USD
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let ethUsdPrice = 3000;    // Updated from WETH/USDC pools
let btcUsdPrice = 100000;  // Updated from cbBTC/USDC pools

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOKEN ADDRESSES ON BASE (verified on basescan.org)
// ⚠️  If a pair shows 0 pools found, re-verify address at basescan.org
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const TOKENS = {
  WETH:  { address: '0x4200000000000000000000000000000000000006', decimals: 18, symbol: 'WETH'  },
  USDC:  { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6,  symbol: 'USDC'  },
  USDT:  { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6,  symbol: 'USDT'  }, // ⚠️ verify
  DAI:   { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18, symbol: 'DAI'   },
  cbETH: { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18, symbol: 'cbETH' },
  WBTC:  { address: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', decimals: 8,  symbol: 'WBTC'  },
  cbBTC: { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8,  symbol: 'cbBTC' },
  BRETT: { address: '0x532f27101965dd16442E59d40670FaF5eBb142E4', decimals: 18, symbol: 'BRETT' }, // ⚠️ verify
  DEGEN: { address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', decimals: 18, symbol: 'DEGEN' }, // ⚠️ verify
  TOSHI: { address: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4', decimals: 18, symbol: 'TOSHI' }, // ⚠️ verify
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FACTORY CONTRACTS ON BASE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const FACTORIES = [
  { name: 'Uniswap V2',      address: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6', type: 'V2' },
  { name: 'Uniswap V3',      address: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', type: 'V3', feeTiers: [100, 500, 3000, 10000] },
  { name: 'SushiSwap V2',    address: '0x71524B4f93c58fcbF659783284E38825f0622859', type: 'V2' },
  { name: 'SushiSwap V3',    address: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4', type: 'V3', feeTiers: [100, 500, 3000, 10000] },
  { name: 'Aerodrome',       address: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da', type: 'AERO' },
  { name: 'PancakeSwap V2',  address: '0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E', type: 'V2' },
  { name: 'PancakeSwap V3',  address: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', type: 'V3', feeTiers: [100, 500, 2500, 10000] },
  { name: 'BaseSwap V2',     address: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB', type: 'V2' },
  { name: 'AlienBase V2',    address: '0x3E84D913803b02A4a7f027165E8cA42C14C0FdE7', type: 'V2' },
  { name: 'SwapBased V2',    address: '0x04C9f118d21e8B767D2e50C946f0cC9F6C367300', type: 'V2' },
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PAIRS TO WATCH (12 total)
// minLiquidity: per-pair minimum in USD
// Core pairs: $50k, Volatile meme pairs: $100k
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WETH/USDC ONLY — debug mode
// Once signals confirmed working, uncomment pairs one by one
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const WATCH_PAIRS = [
  { name: 'WETH/USDC', tokenA: TOKENS.WETH, tokenB: TOKENS.USDC, minLiquidity: 10000 },

  // { name: 'WETH/USDT',  tokenA: TOKENS.WETH,  tokenB: TOKENS.USDT,  minLiquidity: 10000 },
  // { name: 'USDC/USDT',  tokenA: TOKENS.USDC,  tokenB: TOKENS.USDT,  minLiquidity: 10000 },
  // { name: 'DAI/USDC',   tokenA: TOKENS.DAI,   tokenB: TOKENS.USDC,  minLiquidity: 10000 },
  // { name: 'cbETH/WETH', tokenA: TOKENS.cbETH, tokenB: TOKENS.WETH,  minLiquidity: 10000 },
  // { name: 'WBTC/WETH',  tokenA: TOKENS.WBTC,  tokenB: TOKENS.WETH,  minLiquidity: 10000 },
  // { name: 'cbBTC/WBTC', tokenA: TOKENS.cbBTC, tokenB: TOKENS.WBTC,  minLiquidity: 10000 },
  // { name: 'cbBTC/WETH', tokenA: TOKENS.cbBTC, tokenB: TOKENS.WETH,  minLiquidity: 10000 },
  // { name: 'cbBTC/USDC', tokenA: TOKENS.cbBTC, tokenB: TOKENS.USDC,  minLiquidity: 10000 },
  // { name: 'BRETT/WETH', tokenA: TOKENS.BRETT, tokenB: TOKENS.WETH,  minLiquidity: 20000 },
  // { name: 'DEGEN/WETH', tokenA: TOKENS.DEGEN, tokenB: TOKENS.WETH,  minLiquidity: 20000 },
  // { name: 'TOSHI/WETH', tokenA: TOKENS.TOSHI, tokenB: TOKENS.WETH,  minLiquidity: 20000 },
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ABIs
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const V2_FACTORY_ABI   = ['function getPair(address,address) view returns (address)'];
const V3_FACTORY_ABI   = ['function getPool(address,address,uint24) view returns (address)'];
const AERO_FACTORY_ABI = ['function getPool(address,address,bool) view returns (address)'];
const V2_POOL_ABI = [
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)',
];
const V3_POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)',
  'function token0() view returns (address)',
  'function liquidity() view returns (uint128)',  // ← ACTIVE liquidity in current tick
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PRICE HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function sqrtPriceX96ToHumanPrice(sqrtPriceX96, isTokenAToken0, tokenADec, tokenBDec) {
  const sqrtPrice = Number(sqrtPriceX96) / 79228162514264337593543950336; // ÷ 2^96
  const rawPrice = sqrtPrice * sqrtPrice;
  if (rawPrice === 0) return null;
  const decimalFactor = Math.pow(10, tokenADec - tokenBDec);
  return isTokenAToken0 ? rawPrice * decimalFactor : (1 / rawPrice) * decimalFactor;
}

// Returns the USD price of one unit of the given token symbol
function getTokenUsdPrice(symbol) {
  if (['USDC', 'USDT', 'DAI'].includes(symbol)) return 1;
  if (symbol === 'WETH') return ethUsdPrice;
  if (['WBTC', 'cbBTC'].includes(symbol)) return btcUsdPrice;
  return null; // unknown — meme coins priced via WETH
}

// Compute pool USD liquidity from active reserves
function computeLiquidityUSD(pool, reserveA, reserveB) {
  const priceB = getTokenUsdPrice(pool.tokenB.symbol);
  if (priceB) return reserveB * priceB * 2;
  const priceA = getTokenUsdPrice(pool.tokenA.symbol);
  if (priceA) return reserveA * priceA * 2;
  return 0; // can't compute yet (price unknown on first scan)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SANITY CHECK — filter clearly wrong prices
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function filterSanePrices(pools) {
  if (pools.length <= 2) return pools;
  const prices = pools.map(p => p.price).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  return pools.filter(p => {
    const ratio = p.price / median;
    const sane = ratio > 0.5 && ratio < 2.0; // tight: removes sAMM/bad price pools
    if (!sane) console.log(`  ⚠️  Filtered bad price: ${p.dex} @ ${p.price.toFixed(6)} (median: ${median.toFixed(6)})`);
    return sane;
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DISCOVER ALL POOLS FROM FACTORIES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function discoverAllPools() {
  console.log('\n🔍 Discovering pools from factory contracts...');
  const allPools = [];
  const ZERO = '0x0000000000000000000000000000000000000000';

  for (const pair of WATCH_PAIRS) {
    console.log(`\n  Pair: ${pair.name}`);
    for (const factory of FACTORIES) {
      try {
        if (factory.type === 'V2') {
          const contract = new ethers.Contract(factory.address, V2_FACTORY_ABI, provider);
          const addr = await contract.getPair(pair.tokenA.address, pair.tokenB.address);
          if (addr && addr !== ZERO) {
            allPools.push({ pair: pair.name, dex: factory.name, type: 'V2', address: addr,
              tokenA: pair.tokenA, tokenB: pair.tokenB, fee: 0.003, minLiquidity: pair.minLiquidity });
            console.log(`    ✅ ${factory.name}: ${addr}`);
          }
        }
        if (factory.type === 'V3') {
          const contract = new ethers.Contract(factory.address, V3_FACTORY_ABI, provider);
          for (const fee of factory.feeTiers) {
            const addr = await contract.getPool(pair.tokenA.address, pair.tokenB.address, fee);
            if (addr && addr !== ZERO) {
              allPools.push({ pair: pair.name, dex: `${factory.name} ${fee/10000}%`, type: 'V3',
                address: addr, tokenA: pair.tokenA, tokenB: pair.tokenB,
                fee: fee / 1000000, minLiquidity: pair.minLiquidity });
              console.log(`    ✅ ${factory.name} ${fee/10000}%: ${addr}`);
            }
          }
        }
        if (factory.type === 'AERO') {
          const contract = new ethers.Contract(factory.address, AERO_FACTORY_ABI, provider);
          // sAMM is designed for same-price tokens (USDC/USDT). For WETH/USDC it gives
          // distorted reserves → fake 200% price gap every scan. Exclude from non-stable pairs.
          const stables = ['USDC', 'USDT', 'DAI'];
          const isStablePair = stables.includes(pair.tokenA.symbol) && stables.includes(pair.tokenB.symbol);
          const poolTypes = isStablePair ? [false, true] : [false]; // vAMM only for non-stable pairs
          for (const stable of poolTypes) {
            const addr = await contract.getPool(pair.tokenA.address, pair.tokenB.address, stable);
            if (addr && addr !== ZERO) {
              allPools.push({ pair: pair.name, dex: `Aerodrome ${stable ? 'sAMM' : 'vAMM'}`,
                type: 'V2', address: addr, tokenA: pair.tokenA, tokenB: pair.tokenB,
                fee: stable ? 0.0001 : 0.003, minLiquidity: pair.minLiquidity });
              console.log(`    ✅ Aerodrome ${stable ? 'sAMM' : 'vAMM'}: ${addr}`);
            }
          }
        }
      } catch (e) { /* pool doesn't exist on this dex */ }
      await sleep(150);
    }
  }

  console.log(`\n✅ Discovery complete. Found ${allPools.length} pools total.\n`);
  return allPools;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GET V2 POOL DATA (unchanged — x*y=k is exact)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function getV2PoolData(pool) {
  try {
    const contract = new ethers.Contract(pool.address, V2_POOL_ABI, provider);
    const [reserves, token0Addr] = await Promise.all([contract.getReserves(), contract.token0()]);

    const isTokenAToken0 = token0Addr.toLowerCase() === pool.tokenA.address.toLowerCase();
    const reserveA = isTokenAToken0
      ? parseFloat(ethers.formatUnits(reserves[0], pool.tokenA.decimals))
      : parseFloat(ethers.formatUnits(reserves[1], pool.tokenA.decimals));
    const reserveB = isTokenAToken0
      ? parseFloat(ethers.formatUnits(reserves[1], pool.tokenB.decimals))
      : parseFloat(ethers.formatUnits(reserves[0], pool.tokenB.decimals));

    if (reserveA === 0 || reserveB === 0) return null;

    const price = reserveB / reserveA;
    const liquidityUSD = computeLiquidityUSD(pool, reserveA, reserveB);

    return { ...pool, x: reserveA, y: reserveB, k: reserveA * reserveB, price, liquidityUSD };
  } catch (e) { return null; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GET V3 POOL DATA — ACTIVE LIQUIDITY FIX
//
// THE PROBLEM (what the old code did):
//   Used balanceOf() to read total token balances.
//   A V3 pool can show $30M TVL but only $500k is active
//   at the current price tick. balanceOf() returns $30M.
//   This massively overstates tradeable liquidity and gives
//   completely wrong slippage/profit estimates.
//
// THE FIX (what we do now):
//   Call liquidity() → returns L (active liquidity units)
//   In V3, the virtual reserves at current sqrtPrice P are:
//     x_active_raw = L / P_raw       (token0 amount, raw units)
//     y_active_raw = L * P_raw       (token1 amount, raw units)
//   where P_raw = sqrtPriceX96 / 2^96
//
//   These are the ACTUAL reserves tradeable right now.
//   x*y=k holds locally for these values.
//   Much more accurate for slippage calculation.
//
// LIMITATION:
//   This is still a local approximation — if a trade is large
//   enough to cross tick boundaries, actual output is less.
//   We apply a 5% max trade size cap + 20% safety margin
//   on profit to account for this.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function getV3PoolData(pool) {
  try {
    const contract = new ethers.Contract(pool.address, V3_POOL_ABI, provider);
    const [slot0Data, token0Addr, liquidityRaw] = await Promise.all([
      contract.slot0(),
      contract.token0(),
      contract.liquidity(),
    ]);

    const sqrtPriceX96 = slot0Data[0];
    if (sqrtPriceX96 === 0n) return null;

    const isTokenAToken0 = token0Addr.toLowerCase() === pool.tokenA.address.toLowerCase();
    const price = sqrtPriceX96ToHumanPrice(sqrtPriceX96, isTokenAToken0, pool.tokenA.decimals, pool.tokenB.decimals);
    if (!price || price <= 0 || !isFinite(price)) return null;

    // Compute active reserves from L
    const Q96 = 79228162514264337593543950336; // 2^96
    const sqrtP_raw = Number(sqrtPriceX96) / Q96;
    const L = Number(liquidityRaw);
    // L=0 means price moved to a tick with no providers. Don't drop pool entirely —
    // use 2% of actual token balances as conservative active estimate.

    // Virtual reserves in raw (smallest) token units
    const x0_raw = L / sqrtP_raw; // token0
    const y0_raw = L * sqrtP_raw; // token1

    // Convert to human amounts
    let activeX, activeY;
    if (isTokenAToken0) {
      activeX = x0_raw / Math.pow(10, pool.tokenA.decimals);
      activeY = y0_raw / Math.pow(10, pool.tokenB.decimals);
    } else {
      // tokenA is token1, tokenB is token0
      activeX = y0_raw / Math.pow(10, pool.tokenA.decimals);
      activeY = x0_raw / Math.pow(10, pool.tokenB.decimals);
    }

    // Fallback: if L=0 or calculation invalid, use 2% of token balances
    if (L === 0 || activeX <= 0 || activeY <= 0 || !isFinite(activeX) || !isFinite(activeY)) {
      // Fetch actual balances as fallback
      try {
        const erc20 = ['function balanceOf(address) view returns (uint256)'];
        const t0c = new ethers.Contract(token0Addr, erc20, provider);
        const t1Addr = isTokenAToken0 ? pool.tokenB.address : pool.tokenA.address;
        const t1c = new ethers.Contract(t1Addr, erc20, provider);
        const [b0, b1] = await Promise.all([t0c.balanceOf(pool.address), t1c.balanceOf(pool.address)]);
        const tvlX = isTokenAToken0
          ? parseFloat(ethers.formatUnits(b0, pool.tokenA.decimals))
          : parseFloat(ethers.formatUnits(b1, pool.tokenA.decimals));
        const tvlY = isTokenAToken0
          ? parseFloat(ethers.formatUnits(b1, pool.tokenB.decimals))
          : parseFloat(ethers.formatUnits(b0, pool.tokenB.decimals));
        if (tvlX > 0 && tvlY > 0) {
          activeX = tvlX * 0.02;
          activeY = tvlY * 0.02;
        } else { return null; }
      } catch { return null; }
    }
    if (activeX <= 0 || activeY <= 0) return null;

    const liquidityUSD = computeLiquidityUSD(pool, activeX, activeY);

    return {
      ...pool,
      x: activeX,
      y: activeY,
      k: activeX * activeY,
      price,
      liquidityUSD,
      activeOnly: true, // flag so we know this is active liquidity
    };
  } catch (e) { return null; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SIMULATE TRADE USING X*Y=K
// Works for V2 (exact) and V3 (local approximation)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function simulateTrade(pool, inputAmount, buyingTokenA) {
  const { x, y, k, fee } = pool;
  const inputAfterFee = inputAmount * (1 - fee);

  if (buyingTokenA) {
    // Spending tokenB to get tokenA
    const newY = y + inputAfterFee;
    const newX = k / newY;
    return x - newX;
  } else {
    // Spending tokenA to get tokenB
    const newX = x + inputAfterFee;
    const newY = k / newX;
    return y - newY;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FIND BEST TRADE SIZE
//
// Now handles all pool type combinations:
//   V2 → V2: exact x*y=k, up to 10% liquidity
//   V3 → V3: active k approximation, up to 5%,
//             plus 20% safety haircut on profit
//   V2 → V3 / V3 → V2: mixed, 5% cap, 20% haircut
//
// Returns: { size (USD), profitUSD, isEstimate }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function findBestTradeSize(buyPool, sellPool) {
  const USD_SIZES = [1000, 5000, 10000, 25000, 50000, 100000, 200000, 500000];
  const isV3Trade = buyPool.type === 'V3' || sellPool.type === 'V3';
  const maxFraction = isV3Trade ? 0.05 : 0.10;  // stay within tick range for V3
  const safetyFactor = isV3Trade ? 0.80 : 1.00; // 20% haircut for V3 tick-crossing risk

  const tokenBPriceUSD = getTokenUsdPrice(buyPool.tokenB.symbol) || 1;

  let best = { size: 0, profitUSD: 0, isEstimate: isV3Trade };

  for (const usdSize of USD_SIZES) {
    const inputTokenB = usdSize / tokenBPriceUSD;

    // Buy pool: check we're not spending more than maxFraction of tokenB reserves
    if (inputTokenB > buyPool.y * maxFraction) continue;

    // Simulate buy: spend inputTokenB, receive tokenA
    const tokenAReceived = simulateTrade(buyPool, inputTokenB, true);
    if (tokenAReceived <= 0) continue;

    // Sell pool: check tokenA received doesn't exceed its reserves
    if (tokenAReceived > sellPool.x * maxFraction) continue;

    // Simulate sell: spend tokenAReceived, receive tokenB
    const tokenBReceived = simulateTrade(sellPool, tokenAReceived, false);
    if (tokenBReceived <= 0) continue;

    // Flash loan fee (Aave 0.09% on borrowed tokenB)
    const flashFee = inputTokenB * 0.0009;
    const profitTokenB = (tokenBReceived - inputTokenB - flashFee) * safetyFactor;
    const profitUSD = profitTokenB * tokenBPriceUSD;

    if (profitUSD > best.profitUSD) {
      best = { size: usdSize, profitUSD, isEstimate: isV3Trade };
    }
  }
  return best;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN SCAN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function scan(allPools) {
  console.log(`\n[${new Date().toISOString()}] Scanning ${allPools.length} pools...`);

  // Batch RPC calls: 20 pools at a time with 400ms between batches.
  // Firing all 167 pools at once = 500+ simultaneous Alchemy calls → rate limit → "0 active pools".
  const poolDataRaw = [];
  const BATCH = 20;
  for (let i = 0; i < allPools.length; i += BATCH) {
    const slice = allPools.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map(p => p.type === 'V3' ? getV3PoolData(p) : getV2PoolData(p))
    );
    poolDataRaw.push(...results);
    if (i + BATCH < allPools.length) await sleep(400);
  }

  // ── Update live ETH/BTC prices from on-chain pools ──────────────────────
  const wethUsdcPools = poolDataRaw.filter(p => p && p.pair === 'WETH/USDC' && p.price > 100);
  if (wethUsdcPools.length > 0) {
    const ps = wethUsdcPools.map(p => p.price).sort((a, b) => a - b);
    ethUsdPrice = ps[Math.floor(ps.length / 2)];
    console.log(`  📊 ETH: $${ethUsdPrice.toFixed(2)}`);
  }
  const btcUsdcPools = poolDataRaw.filter(p => p && p.pair === 'cbBTC/USDC' && p.price > 1000);
  if (btcUsdcPools.length > 0) {
    const ps = btcUsdcPools.map(p => p.price).sort((a, b) => a - b);
    btcUsdPrice = ps[Math.floor(ps.length / 2)];
    console.log(`  📊 BTC: $${btcUsdPrice.toFixed(2)}`);
  }

  // ── Recalculate liquidityUSD now that we have current prices ────────────
  // (Important for meme coin pairs priced in WETH)
  for (const p of poolDataRaw) {
    if (p && p.liquidityUSD === 0) {
      p.liquidityUSD = computeLiquidityUSD(p, p.x, p.y);
    }
  }

  // ── Filter pools below minimum liquidity ───────────────────────────────
  const poolData = poolDataRaw.filter(p =>
    p !== null &&
    p.liquidityUSD >= (p.minLiquidity || MIN_LIQUIDITY_USD) &&
    isFinite(p.price) &&
    p.price > 0
  );

  const rpcFailed = poolDataRaw.filter(p => p === null).length;
  const belowThresh = poolDataRaw.filter(p => p !== null).length - poolData.length;
  console.log(`  ✅ Active: ${poolData.length} | ❌ RPC failed: ${rpcFailed} | 🔽 Below threshold: ${belowThresh}`);

  // ── Group by pair ───────────────────────────────────────────────────────
  const groups = {};
  for (const pool of poolData) {
    if (!groups[pool.pair]) groups[pool.pair] = [];
    groups[pool.pair].push(pool);
  }

  // Log price summary per pair — makes it clear WHY there's no gap
  for (const [pairName, pools] of Object.entries(groups)) {
    const sorted = [...pools].sort((a, b) => a.price - b.price);
    const gap = sorted.length >= 2
      ? ((sorted[sorted.length-1].price - sorted[0].price) / sorted[0].price * 100).toFixed(3)
      : '0.000';
    const prices = sorted.map(p => `${p.dex.split(' ').slice(-2).join(' ')}=$${p.price.toFixed(2)}`).join(' | ');
    console.log(`  📈 ${pairName} gap=${gap}% [${prices}]`);
  }

  const opportunities = [];

  for (const [pairName, pools] of Object.entries(groups)) {
    if (pools.length < 2) continue;

    const sanePools = filterSanePrices(pools);
    if (sanePools.length < 2) continue;

    sanePools.sort((a, b) => a.price - b.price);
    const buyPool  = sanePools[0];
    const sellPool = sanePools[sanePools.length - 1];

    const gapPct = ((sellPool.price - buyPool.price) / buyPool.price) * 100;
    if (gapPct < MIN_GAP_PERCENT) continue;

    if (gapPct > 50) {
      console.log(`  ⚠️  ${pairName}: Gap ${gapPct.toFixed(2)}% — too large, likely bad price, skipping`);
      continue;
    }

    const { size: bestSize, profitUSD: bestProfitUSD, isEstimate } = findBestTradeSize(buyPool, sellPool);

    if (bestProfitUSD <= 0) {
      console.log(`  ❌ ${pairName}: Gap ${gapPct.toFixed(3)}% but slippage kills profit`);
      continue;
    }

    opportunities.push({ pairName, buyPool, sellPool, gapPct, bestSize, bestProfitUSD, pools: sanePools, isEstimate });
    console.log(`  ✅ ${pairName} | Gap: ${gapPct.toFixed(3)}% | $${bestSize.toLocaleString()} → $${bestProfitUSD.toFixed(2)} profit${isEstimate ? ' (est)' : ''}`);
  }

  return opportunities;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TELEGRAM
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function formatAlert(opp) {
  const allPrices = opp.pools
    .map(p => {
      const liqLabel = p.activeOnly ? '🟡active' : '💧total';
      return `${p.dex}: $${p.price.toFixed(4)} | Liq: $${Math.round(p.liquidityUSD).toLocaleString()} ${liqLabel}`;
    })
    .join('\n');

  const profitNote = opp.isEstimate
    ? ' <i>(V3 active liq. estimate, 20% safety margin applied)</i>'
    : '';

  return `🟢 <b>ARB SIGNAL — ${opp.pairName}</b>

📐 Gap: <b>${opp.gapPct.toFixed(3)}%</b>

🔻 <b>BUY on</b> ${opp.buyPool.dex}
   Price: $${opp.buyPool.price.toFixed(6)}
   x: ${opp.buyPool.x.toFixed(4)} ${opp.buyPool.tokenA.symbol}
   y: ${opp.buyPool.y.toFixed(4)} ${opp.buyPool.tokenB.symbol}
   k: ${opp.buyPool.k.toFixed(2)}
   Liquidity: $${Math.round(opp.buyPool.liquidityUSD).toLocaleString()}${opp.buyPool.activeOnly ? ' 🟡(active)' : ''}

🔺 <b>SELL on</b> ${opp.sellPool.dex}
   Price: $${opp.sellPool.price.toFixed(6)}
   Liquidity: $${Math.round(opp.sellPool.liquidityUSD).toLocaleString()}${opp.sellPool.activeOnly ? ' 🟡(active)' : ''}

💰 <b>Optimal size:</b> $${opp.bestSize.toLocaleString()}
💵 <b>Est. profit:</b> $${opp.bestProfitUSD.toFixed(2)}${profitNote}
   (after DEX fees + Aave 0.09% + slippage)

🏪 <b>All pools:</b>
${allPrices}

⏰ ${new Date().toUTCString()}`;
}

async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('Telegram error:', e.message); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   Ghost Arb Monitor v4.7             ║');
  console.log('║   Full Audit Fix — All 12 Pairs      ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Min gap: ${MIN_GAP_PERCENT}% | Min liquidity: $${MIN_LIQUIDITY_USD.toLocaleString()}`);
  console.log(`Watching ${WATCH_PAIRS.length} pairs across ${FACTORIES.length} DEXes`);

  const allPools = await discoverAllPools();
  if (allPools.length === 0) { console.error('❌ No pools found. Check RPC.'); process.exit(1); }

  await sendTelegram(`🤖 <b>Ghost Arb Monitor v4.7 LIVE</b>

✅ Batched RPC (20/batch, 400ms gap) — no more 0/47 flip
✅ isScanning guard — no overlapping scans
✅ sAMM excluded from non-stablecoin pairs
✅ Gap threshold: 0.5% | Min liquidity: $10k
✅ Tight sanity filter (0.5–2.0x) removes bad prices
✅ Per-pair price logging shows WHY no gap exists
✅ L=0 fallback: 2% TVL estimate
✅ Found <b>${allPools.length} pools</b> across ${FACTORIES.length} DEXes
⚠️ V3 profits marked (est.) with 20% safety margin

Scanning every ${SCAN_INTERVAL_MS / 1000}s`);

  let isScanning = false; // Guard against overlapping scans
  const run = async () => {
    if (isScanning) {
      console.log('  ⏭️  Previous scan still running — skipping this cycle.');
      return;
    }
    isScanning = true;
    try {
      const opps = await scan(allPools);
      if (opps.length === 0) {
        console.log('  No profitable opportunities this cycle.');
        return;
      }
      for (const opp of opps) {
        await sendTelegram(formatAlert(opp));
        await sleep(500);
      }
    } catch (e) { console.error('Scan error:', e.message); }
    finally { isScanning = false; }
  };

  await run();
  setInterval(run, SCAN_INTERVAL_MS);
}

main().catch(console.error);
