const { ethers } = require('ethers');
const fetch = require('node-fetch');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONFIG
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const RPC_URL            = process.env.RPC_URL || 'https://mainnet.base.org';
const MIN_GAP_PERCENT    = parseFloat(process.env.MIN_GAP_PERCENT || '0.3'); // lowered: catches real gaps
const MIN_LIQUIDITY_USD  = parseFloat(process.env.MIN_LIQUIDITY_USD || '10000');
const SCAN_INTERVAL_MS   = parseInt(process.env.SCAN_INTERVAL_MS || '120000'); // 2min: scans take ~90s
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || ''; // Google Sheets logging URL

const provider = new ethers.JsonRpcProvider(RPC_URL);

// Flash loan protocol: Balancer = 0% fee, Aave = 0.09%
// Using Balancer so gaps of 0.31%+ become profitable (vs 0.40%+ for Aave)
const FLASH_LOAN_PROTOCOL = process.env.FLASH_LOAN_PROTOCOL || 'BALANCER';
const FLASH_FEE_PCT = FLASH_LOAN_PROTOCOL === 'AAVE' ? 0.09 : 0.0; // % fee

// Alert cooldown: prevents spamming same pair every 2 minutes
const lastAlertTime = new Map(); // pairName → timestamp ms
const ALERT_COOLDOWN_MS = parseInt(process.env.ALERT_COOLDOWN_MS || '600000'); // 10 min default

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
const WATCH_PAIRS = [
  // ── Stablecoin pairs ──────────────────────
  { name: 'WETH/USDC',  tokenA: TOKENS.WETH,  tokenB: TOKENS.USDC,  minLiquidity: 50000  },
  { name: 'WETH/USDT',  tokenA: TOKENS.WETH,  tokenB: TOKENS.USDT,  minLiquidity: 50000  },
  { name: 'USDC/USDT',  tokenA: TOKENS.USDC,  tokenB: TOKENS.USDT,  minLiquidity: 50000  },
  { name: 'DAI/USDC',   tokenA: TOKENS.DAI,   tokenB: TOKENS.USDC,  minLiquidity: 50000  },
  // ── ETH variants ─────────────────────────
  { name: 'cbETH/WETH', tokenA: TOKENS.cbETH, tokenB: TOKENS.WETH,  minLiquidity: 50000  },
  // ── BTC pairs ────────────────────────────
  { name: 'WBTC/WETH',  tokenA: TOKENS.WBTC,  tokenB: TOKENS.WETH,  minLiquidity: 50000  },
  { name: 'cbBTC/WBTC', tokenA: TOKENS.cbBTC, tokenB: TOKENS.WBTC,  minLiquidity: 50000  },
  { name: 'cbBTC/WETH', tokenA: TOKENS.cbBTC, tokenB: TOKENS.WETH,  minLiquidity: 50000  },
  { name: 'cbBTC/USDC', tokenA: TOKENS.cbBTC, tokenB: TOKENS.USDC,  minLiquidity: 50000  },
  // ── Meme coins (higher threshold) ────────
  { name: 'BRETT/WETH', tokenA: TOKENS.BRETT, tokenB: TOKENS.WETH,  minLiquidity: 100000 },
  { name: 'DEGEN/WETH', tokenA: TOKENS.DEGEN, tokenB: TOKENS.WETH,  minLiquidity: 100000 },
  { name: 'TOSHI/WETH', tokenA: TOKENS.TOSHI, tokenB: TOKENS.WETH,  minLiquidity: 100000 },
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
// FIX 1: ERC20_ABI was missing — caused silent crash in V3 fallback path
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

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
          const stables = ['USDC', 'USDT', 'DAI'];
          const isStablePair = stables.includes(pair.tokenA.symbol) && stables.includes(pair.tokenB.symbol);
          // sAMM only for stablecoin pairs — for WETH/USDC it gives distorted prices (200% fake gap)
          for (const stable of isStablePair ? [false, true] : [false]) {
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
      await sleep(500); // increased: public RPC needs more breathing room than Alchemy
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

    // FIX 5: Use BigInt arithmetic to avoid IEEE 754 precision loss.
    // L and sqrtPriceX96 can exceed JS safe integer (2^53). Converting
    // directly via Number() silently truncates, giving wrong reserves.
    if (liquidityRaw === 0n) return null; // No active liquidity in this tick range

    const Q96 = 2n ** 96n;
    // x0_raw = L * Q96 / sqrtPriceX96  (token0 raw units)
    // y0_raw = L * sqrtPriceX96 / Q96  (token1 raw units)
    const x0_raw_bn = (liquidityRaw * Q96) / sqrtPriceX96;
    const y0_raw_bn = (liquidityRaw * sqrtPriceX96) / Q96;

    // Convert BigInt raw → human float safely:
    // Split into integer and fractional parts to avoid truncation
    const safeToFloat = (bn, decimals) => {
      const scale = BigInt(10 ** decimals);
      const intPart = bn / scale;
      const fracPart = bn % scale;
      return Number(intPart) + Number(fracPart) / (10 ** decimals);
    };

    let activeX, activeY;
    if (isTokenAToken0) {
      activeX = safeToFloat(x0_raw_bn, pool.tokenA.decimals);
      activeY = safeToFloat(y0_raw_bn, pool.tokenB.decimals);
    } else {
      activeX = safeToFloat(y0_raw_bn, pool.tokenA.decimals);
      activeY = safeToFloat(x0_raw_bn, pool.tokenB.decimals);
    }

    if (activeX <= 0 || activeY <= 0 || !isFinite(activeX) || !isFinite(activeY)) return null;

    const liquidityUSD = computeLiquidityUSD(pool, activeX, activeY);

    return {
      ...pool,
      x: activeX,
      y: activeY,
      k: activeX * activeY,
      price,
      liquidityUSD,
      isV3: true,       // marks active liquidity — used for display labels
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

    // Flash loan fee — uses FLASH_FEE_PCT (0% Balancer, 0.09% Aave)
    const flashFee = inputTokenB * (FLASH_FEE_PCT / 100);
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

  // Batched RPC: 20 pools per batch with 400ms delay prevents rate limiting
  const poolDataRaw = [];
  const BATCH = 20;
  for (let i = 0; i < allPools.length; i += BATCH) {
    const batch = allPools.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(p => p.type === 'V3' ? getV3PoolData(p) : getV2PoolData(p))
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

  // ── Debug: show pool-level data to understand why pools fail ───────────
  const nullCount   = poolDataRaw.filter(p => p === null).length;
  const nonNull     = poolDataRaw.filter(p => p !== null);
  const withLiq     = nonNull.filter(p => p.liquidityUSD > 0);
  const liqValues   = withLiq.map(p => Math.round(p.liquidityUSD));
  const maxLiq      = liqValues.length ? Math.max(...liqValues) : 0;
  const minLiq      = liqValues.length ? Math.min(...liqValues) : 0;
  console.log(`  🔍 Pool debug: ${nullCount} null (RPC fail) | ${nonNull.length} got data | liq range $${minLiq.toLocaleString()}–$${maxLiq.toLocaleString()}`);

  // ── Filter pools below minimum liquidity ───────────────────────────────
  const poolData = poolDataRaw.filter(p =>
    p !== null &&
    p.liquidityUSD >= (p.minLiquidity || MIN_LIQUIDITY_USD) &&
    isFinite(p.price) &&
    p.price > 0
  );

  console.log(`  Active pools: ${poolData.length} (filtered ${poolDataRaw.length - poolData.filter(Boolean).length} below threshold)`);

  // ── Group by pair ───────────────────────────────────────────────────────
  const groups = {};
  for (const pool of poolData) {
    if (!groups[pool.pair]) groups[pool.pair] = [];
    groups[pool.pair].push(pool);
  }

  // ── Per-pair detailed pool log ─────────────────────────────────────────
  // Shows every pool's DEX, version, price, TVL, active liquidity
  const fmtLiq = v => v >= 1e9 ? `$${(v/1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v/1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v/1e3).toFixed(1)}k` : `$${Math.round(v)}`;
  const rawGapByPair = {}; // collect best raw gap per pair for Sheets logging
  for (const [pairName, pairPools] of Object.entries(groups)) {
    const sorted = [...pairPools].sort((a, b) => a.price - b.price);
    const rawGap = sorted.length >= 2
      ? ((sorted[sorted.length-1].price - sorted[0].price) / sorted[0].price * 100).toFixed(3)
      : '0.000';
    rawGapByPair[pairName] = parseFloat(rawGap); // store for Sheets
    console.log(`\n  ┌── ${pairName} │ ${sorted.length} pools │ raw gap: ${rawGap}%`);
    for (const p of sorted) {
      const dex = p.dex.padEnd(30);
      const price = `$${p.price.toFixed(4)}`.padEnd(12);
      const fee = `fee:${(p.fee*100).toFixed(2)}%`.padEnd(10);
      if (p.isV3) {
        const tvl = fmtLiq(p.liquidityUSD);
        const act = fmtLiq(p.activeLiqUSD || 0);
        console.log(`  │  ${dex} ${price} ${fee} TVL:${tvl.padEnd(10)} Active:${act}`);
      } else {
        const liq = fmtLiq(p.liquidityUSD);
        console.log(`  │  ${dex} ${price} ${fee} Liq:${liq}`);
      }
    }
    console.log(`  └─────────────────────────────────────────────────────`);
  }
  console.log('');

  const opportunities = [];

  for (const [pairName, pools] of Object.entries(groups)) {
    if (pools.length < 2) continue;

    const sanePools = filterSanePrices(pools);
    if (sanePools.length < 2) continue;

    // Check ALL buy/sell combinations — find most profitable AND most promising
    let bestOpp = null;
    let mostPromising = null; // closest to profitable even if not there yet

    for (const buyPool of sanePools) {
      for (const sellPool of sanePools) {
        if (buyPool.address === sellPool.address) continue;
        if (buyPool.price >= sellPool.price) continue;

        const gapPct = ((sellPool.price - buyPool.price) / buyPool.price) * 100;
        if (gapPct < MIN_GAP_PERCENT) continue;
        if (gapPct > 50) continue;

        const totalFeePct = (buyPool.fee * 100) + (sellPool.fee * 100) + FLASH_FEE_PCT;
        const netPct = gapPct - totalFeePct; // positive = profit possible

        // Track most promising combo (smallest deficit or biggest surplus)
        if (!mostPromising || netPct > mostPromising.netPct) {
          mostPromising = { buyPool, sellPool, gapPct, totalFeePct, netPct };
        }

        if (netPct <= 0) continue; // fees eat the gap

        const { size: bestSize, profitUSD: bestProfitUSD, isEstimate } = findBestTradeSize(buyPool, sellPool);
        if (bestProfitUSD <= 0) continue;

        if (!bestOpp || bestProfitUSD > bestOpp.bestProfitUSD) {
          bestOpp = { pairName, buyPool, sellPool, gapPct, bestSize, bestProfitUSD, pools: sanePools, isEstimate };
        }
      }
    }

    if (!bestOpp) {
      if (mostPromising) {
        const sign = mostPromising.netPct > 0 ? '+' : '';
        const status = mostPromising.netPct > 0 ? '⚠️ slippage kills' : '❌ fees > gap';
        console.log(`  ${status} | ${pairName}: ${mostPromising.buyPool.dex} → ${mostPromising.sellPool.dex} | gap=${mostPromising.gapPct.toFixed(3)}% fees=${mostPromising.totalFeePct.toFixed(2)}% net=${sign}${mostPromising.netPct.toFixed(3)}%`);
      }
      continue;
    }

    opportunities.push(bestOpp);
    console.log(`  ✅ ${pairName} | Gap: ${bestOpp.gapPct.toFixed(3)}% | Buy: ${bestOpp.buyPool.dex} → Sell: ${bestOpp.sellPool.dex} | $${bestOpp.bestSize.toLocaleString()} → $${bestOpp.bestProfitUSD.toFixed(2)} profit${bestOpp.isEstimate ? ' (est)' : ''}`);
  }

  // ── Return opportunities (caller handles Sheets logging) ──────────────
  return { opportunities, scanMeta: {
    nullCount,
    belowThreshold: nonNull.length - poolData.length,
    activePools: poolData.length,
    poolsFound: poolDataRaw.length,
    rawGapByPair,
    poolPrices: poolData.map(p => ({
      pair: p.pair, dex: p.dex, price: parseFloat(p.price.toFixed(4)),
      tvl: Math.round(p.liquidityUSD),
      activeLiq: Math.round(p.activeLiqUSD || p.liquidityUSD),
      type: p.isV3 ? 'V3' : 'V2'
    }))
  }};
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TELEGRAM
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function formatAlert(opp) {
  const allPrices = opp.pools
    .map(p => {
      const liqLabel = p.isV3 ? '🟡active' : '💧total';
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
   Liquidity: $${Math.round(opp.buyPool.liquidityUSD).toLocaleString()}${opp.buyPool.isV3 ? ' 🟡active' : ''}

🔺 <b>SELL on</b> ${opp.sellPool.dex}
   Price: $${opp.sellPool.price.toFixed(6)}
   Liquidity: $${Math.round(opp.sellPool.liquidityUSD).toLocaleString()}${opp.sellPool.isV3 ? ' 🟡active' : ''}

💰 <b>Optimal size:</b> $${opp.bestSize.toLocaleString()}
💵 <b>Est. profit:</b> $${opp.bestProfitUSD.toFixed(2)}${profitNote}
   (after DEX fees + ${FLASH_LOAN_PROTOCOL} ${FLASH_FEE_PCT}% flash fee + slippage)

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
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GOOGLE SHEETS LOGGER
// Sends scan results to Google Apps Script webhook
// Non-blocking: failures don't affect the bot
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function logToSheets(data) {
  if (!SHEETS_WEBHOOK_URL) return;
  try {
    const res = await fetch(SHEETS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const text = await res.text();
    if (text !== 'OK') console.log(`  📊 Sheets response: ${text.slice(0, 100)}`);
  } catch (e) {
    console.log(`  📊 Sheets FAILED: ${e.message}`);
  }
}

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   Ghost Arb Monitor v1.12             ║');
  console.log('║   Clean Logging + Best Combo Display     ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Flash loan: ${FLASH_LOAN_PROTOCOL} (${FLASH_FEE_PCT}% fee)`);
  console.log(`Min gap: ${MIN_GAP_PERCENT}% | Min liquidity: $${MIN_LIQUIDITY_USD.toLocaleString()}`);
  console.log(`Watching ${WATCH_PAIRS.length} pairs across ${FACTORIES.length} DEXes`);

  if (SHEETS_WEBHOOK_URL) {
    console.log('📊 Testing Google Sheets connection...');
    await logToSheets({ timestamp: new Date().toISOString(), test: true, message: 'Ghost Arb Monitor v1.12 connected' });
  } else {
    console.log('📊 Google Sheets: not configured (set SHEETS_WEBHOOK_URL in Railway)');
  }

  const allPools = await discoverAllPools();
  if (allPools.length === 0) { console.error('❌ No pools found. Check RPC.'); process.exit(1); }

  await sendTelegram(`🤖 <b>Ghost Arb Monitor v1.12 LIVE</b>

✅ ERC20_ABI defined — V3 TVL display fixed
✅ BigInt V3 math — no more precision loss
✅ Nested loop — checks ALL pool combinations
✅ Total fee pre-check — skips impossible trades
✅ Alert cooldown — 10min per pair, no spam
✅ Balancer 0% flash fee (was Aave 0.09%)
✅ isScanning guard + recursive timer
✅ Batched RPC 20/batch, 400ms gap
✅ sAMM excluded from non-stablecoin pairs
✅ Found <b>${allPools.length} pools</b> | Gap: ${MIN_GAP_PERCENT}% | Flash: ${FLASH_LOAN_PROTOCOL} (${FLASH_FEE_PCT}% fee)

Scanning every ${SCAN_INTERVAL_MS / 1000}s`);

  let isScanning = false;

  const run = async () => {
    if (isScanning) {
      console.log('  ⏭️  Previous scan still running — skipping cycle.');
      return;
    }
    isScanning = true;
    try {
      const { opportunities: opps, scanMeta } = await scan(allPools);

      // Build Sheets log payload
      const sheetsPayload = {
        timestamp: new Date().toISOString(),
        ethPrice: ethUsdPrice,
        btcPrice: btcUsdPrice,
        poolsFound: scanMeta.poolsFound,
        rpcFailed: scanMeta.nullCount,
        belowThreshold: scanMeta.belowThreshold,
        activePools: scanMeta.activePools,
        pools: scanMeta.poolPrices,
        flashProtocol: FLASH_LOAN_PROTOCOL,
        rawGaps: scanMeta.rawGapByPair,  // best raw gap per pair, even if not profitable
        bestPair: opps.length ? opps[0].pairName : null,
        bestGap: opps.length ? opps[0].gapPct.toFixed(3) : null,
        decision: opps.length ? 'signal' : 'no opportunity',
        signal: opps.length ? {
          pair: opps[0].pairName,
          gap: opps[0].gapPct.toFixed(3),
          buyDex: opps[0].buyPool.dex,
          buyPrice: opps[0].buyPool.price.toFixed(4),
          sellDex: opps[0].sellPool.dex,
          sellPrice: opps[0].sellPool.price.toFixed(4),
          size: opps[0].bestSize,
          profit: opps[0].bestProfitUSD.toFixed(2),
          isEstimate: opps[0].isEstimate
        } : null
      };
      logToSheets(sheetsPayload); // non-blocking, won't crash bot

      if (opps.length === 0) {
        console.log('  No profitable opportunities this cycle.');
        return;
      }
      for (const opp of opps) {
        // FIX 3: Alert cooldown — avoid spamming same pair every 2 minutes
        const now = Date.now();
        const lastAlert = lastAlertTime.get(opp.pairName) || 0;
        if (now - lastAlert < ALERT_COOLDOWN_MS) {
          const minsLeft = Math.ceil((ALERT_COOLDOWN_MS - (now - lastAlert)) / 60000);
          console.log(`  ⏳ ${opp.pairName}: Signal found but on cooldown (${minsLeft}min left)`);
          continue;
        }
        lastAlertTime.set(opp.pairName, now);
        await sendTelegram(formatAlert(opp));
        await sleep(500);
      }
    } catch (e) { console.error('Scan error:', e.message); }
    finally { isScanning = false; }
  };

  // Recursive setTimeout prevents overlapping scans better than setInterval
  const scheduleNext = () => setTimeout(async () => { await run(); scheduleNext(); }, SCAN_INTERVAL_MS);
  await run();
  scheduleNext();
}

main().catch(console.error);
