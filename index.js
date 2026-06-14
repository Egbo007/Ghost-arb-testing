const { ethers } = require('ethers');
const fetch = require('node-fetch');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONFIG
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const RPC_URL            = process.env.RPC_URL || 'https://mainnet.base.org';
const WSS_URL = process.env.WSS_URL || (() => {
  if (RPC_URL.includes('alchemy.com')) return RPC_URL.replace('https://', 'wss://');
  return 'wss://mainnet.base.org';
})();

const MIN_GAP_PERCENT    = parseFloat(process.env.MIN_GAP_PERCENT   || '0.3');
const MIN_LIQUIDITY_USD  = parseFloat(process.env.MIN_LIQUIDITY_USD || '10000');
const SCAN_INTERVAL_MS   = parseInt(process.env.SCAN_INTERVAL_MS    || '120000');
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || '';
const WSS_RECONNECT_MS   = 15000;

// v2.1 NEW — Gas cost deducted from every profit estimate.
// Base chain: flash loan + 2 DEX swaps ≈ $1–5 depending on congestion.
// Default $2 is conservative. Tune via Railway env var ESTIMATED_GAS_USD.
const ESTIMATED_GAS_USD  = parseFloat(process.env.ESTIMATED_GAS_USD || '2');

// v2.1 NEW — WebSocket debounce per pair (ms).
// Prevents 100 simultaneous RPC rescans when WETH/USDC fires 100 swaps/second.
// Bot waits 2s of silence on a pair before scanning it.
const WSS_PAIR_DEBOUNCE_MS = 2000;

const provider = new ethers.JsonRpcProvider(RPC_URL);

const FLASH_LOAN_PROTOCOL = process.env.FLASH_LOAN_PROTOCOL || 'BALANCER';
const FLASH_FEE_PCT = FLASH_LOAN_PROTOCOL === 'AAVE' ? 0.09 : 0.0;

// v2.1 CHANGED — Cooldown key is now pair+buyDex+sellDex (not just pair name).
// So Uniswap→Pancake and Pancake→Uniswap each get their own independent cooldown.
const lastAlertTime = new Map();
const ALERT_COOLDOWN_MS = parseInt(process.env.ALERT_COOLDOWN_MS || '600000');

// Internal state
const pairDebounceTimers = new Map();
let ethUsdPrice = 3000;
let btcUsdPrice = 100000;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOKEN ADDRESSES ON BASE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const TOKENS = {
  WETH:  { address: '0x4200000000000000000000000000000000000006', decimals: 18, symbol: 'WETH'  },
  USDC:  { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6,  symbol: 'USDC'  },
  USDT:  { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6,  symbol: 'USDT'  },
  DAI:   { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18, symbol: 'DAI'   },
  cbETH: { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18, symbol: 'cbETH' },
  WBTC:  { address: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', decimals: 8,  symbol: 'WBTC'  },
  cbBTC: { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8,  symbol: 'cbBTC' },
  BRETT: { address: '0x532f27101965dd16442E59d40670FaF5eBb142E4', decimals: 18, symbol: 'BRETT' },
  DEGEN: { address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', decimals: 18, symbol: 'DEGEN' },
  TOSHI: { address: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4', decimals: 18, symbol: 'TOSHI' },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FACTORY CONTRACTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const FACTORIES = [
  { name: 'Uniswap V2',     address: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6', type: 'V2' },
  { name: 'Uniswap V3',     address: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', type: 'V3', feeTiers: [100, 500, 3000, 10000] },
  { name: 'SushiSwap V2',   address: '0x71524B4f93c58fcbF659783284E38825f0622859', type: 'V2' },
  { name: 'SushiSwap V3',   address: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4', type: 'V3', feeTiers: [100, 500, 3000, 10000] },
  { name: 'Aerodrome',      address: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da', type: 'AERO' },
  { name: 'PancakeSwap V2', address: '0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E', type: 'V2' },
  { name: 'PancakeSwap V3', address: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', type: 'V3', feeTiers: [100, 500, 2500, 10000] },
  { name: 'BaseSwap V2',    address: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB', type: 'V2' },
  { name: 'AlienBase V2',   address: '0x3E84D913803b02A4a7f027165E8cA42C14C0FdE7', type: 'V2' },
  { name: 'SwapBased V2',   address: '0x04C9f118d21e8B767D2e50C946f0cC9F6C367300', type: 'V2' },
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PAIRS TO WATCH (12 total)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const WATCH_PAIRS = [
  { name: 'WETH/USDC',  tokenA: TOKENS.WETH,  tokenB: TOKENS.USDC,  minLiquidity: 50000  },
  { name: 'WETH/USDT',  tokenA: TOKENS.WETH,  tokenB: TOKENS.USDT,  minLiquidity: 50000  },
  { name: 'USDC/USDT',  tokenA: TOKENS.USDC,  tokenB: TOKENS.USDT,  minLiquidity: 50000  },
  { name: 'DAI/USDC',   tokenA: TOKENS.DAI,   tokenB: TOKENS.USDC,  minLiquidity: 50000  },
  { name: 'cbETH/WETH', tokenA: TOKENS.cbETH, tokenB: TOKENS.WETH,  minLiquidity: 50000  },
  { name: 'WBTC/WETH',  tokenA: TOKENS.WBTC,  tokenB: TOKENS.WETH,  minLiquidity: 50000  },
  { name: 'cbBTC/WBTC', tokenA: TOKENS.cbBTC, tokenB: TOKENS.WBTC,  minLiquidity: 50000  },
  { name: 'cbBTC/WETH', tokenA: TOKENS.cbBTC, tokenB: TOKENS.WETH,  minLiquidity: 50000  },
  { name: 'cbBTC/USDC', tokenA: TOKENS.cbBTC, tokenB: TOKENS.USDC,  minLiquidity: 50000  },
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
  'function liquidity() view returns (uint128)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
];
const V2_POOL_SWAP_ABI = [
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// V3 QUOTER
//
// v2.1 FIX: Only called for Uniswap V3 pools (isUniswapV3 === true).
//
// WHY: This Quoter contract (Uniswap QuoterV2) internally derives pool
// addresses using the Uniswap factory. If we call it on a SushiSwap or
// PancakeSwap V3 pool, it either:
//   (a) reverts → we fall back to slot0 estimate (not terrible)
//   (b) accidentally finds a UNISWAP pool with the same tokens+fee and
//       returns that pool's quote — a completely wrong number that makes
//       a non-profitable trade look profitable → FAKE SIGNAL → MONEY LOSS
//
// Fix: tag each V3 pool with isUniswapV3=true/false during discovery.
// Only call Quoter when isUniswapV3 === true.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const QUOTER_ADDRESS = '0x3d4e44Eb1374240CE5F1B136aa68B6a741f674F7';
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];
const quoterContract = new ethers.Contract(QUOTER_ADDRESS, QUOTER_ABI, provider);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PRICE HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// PRICE CALCULATION FIX (v2.1 patch)
//
// BUG IN v2.1: Used PREC=10^9 in BigInt math. For WETH/USDC the intermediate
// result was 1.673 but BigInt truncates decimals -> became 1n.
// rawPrice = 1/1e9 = 1e-9 -> price = 1e-9 * 10^12 = 1000 (WRONG, should be ~1673).
// Every V3 pool showed $1000 instead of the real price.
//
// FIX - Adaptive bit-shifting:
// Right-shift sqrtPriceX96 (BigInt) until s < 2^27, tracking shift count e.
// Then s^2 < 2^54 — safely within JS Number precision (MAX_SAFE_INTEGER = 2^53).
// Math: sqrtPriceX96^2 / 2^192 = (s * 2^e)^2 / 2^192 = s^2 / 2^(192 - 2e)
// No truncation, no overflow, works for all pairs and price ranges.
function sqrtPriceX96ToHumanPrice(sqrtPriceX96BN, isTokenAToken0, tokenADec, tokenBDec) {
  if (!sqrtPriceX96BN || sqrtPriceX96BN === 0n) return null;

  // Right-shift until s < 2^27, counting shifts in e
  let s = sqrtPriceX96BN;
  let e = 0;
  while (s >= (1n << 27n)) { s >>= 1n; e++; }

  const sNum     = Number(s);           // safe: s < 2^27
  const sq       = sNum * sNum;         // safe: sq < 2^54
  const exp      = 192 - 2 * e;
  const rawPrice = exp >= 0
    ? sq / Math.pow(2, exp)
    : sq * Math.pow(2, -exp);

  if (!rawPrice || !isFinite(rawPrice)) return null;

  const decimalFactor = Math.pow(10, tokenADec - tokenBDec);
  return isTokenAToken0
    ? rawPrice * decimalFactor
    : decimalFactor / rawPrice;
}

function getTokenUsdPrice(symbol) {
  if (['USDC', 'USDT', 'DAI'].includes(symbol)) return 1;
  if (symbol === 'WETH' || symbol === 'cbETH') return ethUsdPrice;
  if (['WBTC', 'cbBTC'].includes(symbol)) return btcUsdPrice;
  return null;
}

function computeLiquidityUSD(pool, reserveA, reserveB) {
  const priceB = getTokenUsdPrice(pool.tokenB.symbol);
  if (priceB) return reserveB * priceB * 2;
  const priceA = getTokenUsdPrice(pool.tokenA.symbol);
  if (priceA) return reserveA * priceA * 2;
  return 0;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SANITY CHECK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function filterSanePrices(pools) {
  if (pools.length <= 2) return pools;
  const prices = pools.map(p => p.price).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  return pools.filter(p => {
    const ratio = p.price / median;
    const sane  = ratio > 0.5 && ratio < 2.0;
    if (!sane) console.log(`  ⚠️  Filtered bad price: ${p.dex} @ ${p.price.toFixed(6)} (median: ${median.toFixed(6)})`);
    return sane;
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// POOL DISCOVERY
//
// v2.1 changes:
//   - isUniswapV3: true/false tag on all V3 pools (for Quoter gating)
//   - isStable: true tag on Aerodrome sAMM pools (for arb exclusion)
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
            allPools.push({
              pair: pair.name, dex: factory.name, type: 'V2', address: addr,
              tokenA: pair.tokenA, tokenB: pair.tokenB, fee: 0.003,
              minLiquidity: pair.minLiquidity,
              isStable: false, isUniswapV3: false,
            });
            console.log(`    ✅ ${factory.name}: ${addr}`);
          }
        }

        if (factory.type === 'V3') {
          const contract = new ethers.Contract(factory.address, V3_FACTORY_ABI, provider);
          for (const fee of factory.feeTiers) {
            const addr = await contract.getPool(pair.tokenA.address, pair.tokenB.address, fee);
            if (addr && addr !== ZERO) {
              allPools.push({
                pair: pair.name, dex: `${factory.name} ${fee / 10000}%`, type: 'V3',
                address: addr, tokenA: pair.tokenA, tokenB: pair.tokenB,
                fee: fee / 1000000, v3FeeTier: fee,
                minLiquidity: pair.minLiquidity,
                isStable: false,
                // v2.1: only Uniswap V3 pools can use the Uniswap QuoterV2
                isUniswapV3: factory.name === 'Uniswap V3',
              });
              console.log(`    ✅ ${factory.name} ${fee / 10000}%: ${addr}`);
            }
          }
        }

        if (factory.type === 'AERO') {
          const contract = new ethers.Contract(factory.address, AERO_FACTORY_ABI, provider);
          const stableTokens = ['USDC', 'USDT', 'DAI'];
          const isStablePair = stableTokens.includes(pair.tokenA.symbol) && stableTokens.includes(pair.tokenB.symbol);
          for (const stable of isStablePair ? [false, true] : [false]) {
            const addr = await contract.getPool(pair.tokenA.address, pair.tokenB.address, stable);
            if (addr && addr !== ZERO) {
              allPools.push({
                pair: pair.name, dex: `Aerodrome ${stable ? 'sAMM' : 'vAMM'}`,
                type: 'V2', address: addr, tokenA: pair.tokenA, tokenB: pair.tokenB,
                fee: stable ? 0.0001 : 0.003, minLiquidity: pair.minLiquidity,
                // v2.1 FIX: isStable=true means EXCLUDED from arb scanning.
                // Aerodrome sAMM uses Solidly invariant: x³y + y³x = k
                // Our simulateTrade() uses x*y=k → completely wrong for stable pools.
                // Stable pool prices ARE shown in console/Sheets but never used for arb.
                isStable: stable,
                isUniswapV3: false,
              });
              const tag = stable ? '⚠️ sAMM (arb-excluded — wrong curve)' : 'vAMM';
              console.log(`    ✅ Aerodrome ${tag}: ${addr}`);
            }
          }
        }
      } catch (e) { /* pool doesn't exist on this dex */ }
      await sleep(500);
    }
  }

  const stableCount = allPools.filter(p => p.isStable).length;
  console.log(`\n✅ Discovery complete: ${allPools.length} pools found (${stableCount} sAMM excluded from arb).\n`);
  return allPools;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GET V2 POOL DATA
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

    const price        = reserveB / reserveA;
    const liquidityUSD = computeLiquidityUSD(pool, reserveA, reserveB);
    return { ...pool, x: reserveA, y: reserveB, k: reserveA * reserveB, price, liquidityUSD };
  } catch (e) { return null; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GET V3 POOL DATA
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function getV3PoolData(pool) {
  try {
    const contract = new ethers.Contract(pool.address, V3_POOL_ABI, provider);
    const [slot0Data, token0Addr, liquidityRaw] = await Promise.all([
      contract.slot0(), contract.token0(), contract.liquidity(),
    ]);

    const sqrtPriceX96 = slot0Data[0]; // BigInt in ethers v6
    if (sqrtPriceX96 === 0n) return null;

    const isTokenAToken0 = token0Addr.toLowerCase() === pool.tokenA.address.toLowerCase();

    // v2.1: uses BigInt-safe price function
    const price = sqrtPriceX96ToHumanPrice(
      sqrtPriceX96, isTokenAToken0, pool.tokenA.decimals, pool.tokenB.decimals
    );
    if (!price || price <= 0 || !isFinite(price)) return null;
    if (liquidityRaw === 0n) return null;

    const Q96       = 2n ** 96n;
    const x0_raw_bn = (liquidityRaw * Q96) / sqrtPriceX96;
    const y0_raw_bn = (liquidityRaw * sqrtPriceX96) / Q96;

    const safeToFloat = (bn, decimals) => {
      const scale    = BigInt(10 ** decimals);
      const intPart  = bn / scale;
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
    return { ...pool, x: activeX, y: activeY, k: activeX * activeY, price, liquidityUSD, isV3: true };
  } catch (e) { return null; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// V3 QUOTER — get real swap output
// v2.1 FIX: returns null immediately if pool is not Uniswap V3
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function getV3Quote(pool, inputAmountHuman, buyingTokenA) {
  // v2.1 FIX: Uniswap V3 pools only — see long comment near QUOTER_ADDRESS above
  if (!pool.isUniswapV3 || !pool.v3FeeTier) {
    // VISIBLE SKIP LOG — you will see this in Railway console every time
    // the Quoter is bypassed for a non-Uniswap V3 pool.
    // This means that pool's profit estimate uses slot0 k-approximation
    // with 20% safety margin instead of real swap simulation.
    console.log(`  📊 Quoter skipped: ${pool.dex} (not Uniswap V3 → using slot0 estimate ×0.80)`);
    return null;
  }

  try {
    const tokenIn     = buyingTokenA ? pool.tokenB.address : pool.tokenA.address;
    const tokenOut    = buyingTokenA ? pool.tokenA.address : pool.tokenB.address;
    const decimalsIn  = buyingTokenA ? pool.tokenB.decimals : pool.tokenA.decimals;
    const decimalsOut = buyingTokenA ? pool.tokenA.decimals : pool.tokenB.decimals;

    const amountIn = ethers.parseUnits(inputAmountHuman.toFixed(decimalsIn), decimalsIn);

    const result = await quoterContract.quoteExactInputSingle.staticCall({
      tokenIn, tokenOut, amountIn, fee: pool.v3FeeTier, sqrtPriceLimitX96: 0n,
    });
    return parseFloat(ethers.formatUnits(result[0], decimalsOut));
  } catch (e) { return null; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SIMULATE TRADE (V2 x*y=k only)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function simulateTrade(pool, inputAmount, buyingTokenA) {
  const { x, y, k, fee } = pool;
  const inputAfterFee = inputAmount * (1 - fee);
  if (buyingTokenA) {
    const newY = y + inputAfterFee;
    const newX = k / newY;
    return x - newX;
  } else {
    const newX = x + inputAfterFee;
    const newY = k / newX;
    return y - newY;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FIND BEST TRADE SIZE
//
// v2.1 changes:
//   - Gas cost subtracted: only sizes where profit > gas are returned
//   - Quoter gated to Uniswap V3 only (handled inside getV3Quote)
//   - Returns profitUSD (gross) + profitAfterGasUSD (net) for alert display
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function findBestTradeSize(buyPool, sellPool) {
  const USD_SIZES    = [1000, 5000, 10000, 25000, 50000, 100000, 200000, 500000];
  const isV3Trade    = buyPool.type === 'V3' || sellPool.type === 'V3';
  const maxFraction  = isV3Trade ? 0.05 : 0.10;
  const safetyFactor = isV3Trade ? 0.80 : 1.00;
  const tokenBPriceUSD = getTokenUsdPrice(buyPool.tokenB.symbol) || 1;

  let best = { size: 0, profitUSD: 0, profitAfterGasUSD: 0, isEstimate: isV3Trade, quoterUsed: false, buyQuoterUsed: false, sellQuoterUsed: false };

  for (const usdSize of USD_SIZES) {
    const inputTokenB = usdSize / tokenBPriceUSD;
    if (inputTokenB > buyPool.y * maxFraction) continue;

    // ── Buy leg ──────────────────────────────────────────────────
    let tokenAReceived, buyQuoterUsed = false;
    if (buyPool.type === 'V3') {
      const quoted = await getV3Quote(buyPool, inputTokenB, true);
      if (quoted !== null && quoted > 0) { tokenAReceived = quoted; buyQuoterUsed = true; }
      else tokenAReceived = simulateTrade(buyPool, inputTokenB, true);
    } else {
      tokenAReceived = simulateTrade(buyPool, inputTokenB, true);
    }
    if (!tokenAReceived || tokenAReceived <= 0) continue;
    if (tokenAReceived > sellPool.x * maxFraction) continue;

    // ── Sell leg ─────────────────────────────────────────────────
    let tokenBReceived, sellQuoterUsed = false;
    if (sellPool.type === 'V3') {
      const quoted = await getV3Quote(sellPool, tokenAReceived, false);
      if (quoted !== null && quoted > 0) { tokenBReceived = quoted; sellQuoterUsed = true; }
      else tokenBReceived = simulateTrade(sellPool, tokenAReceived, false);
    } else {
      tokenBReceived = simulateTrade(sellPool, tokenAReceived, false);
    }
    if (!tokenBReceived || tokenBReceived <= 0) continue;

    // ── Profit ───────────────────────────────────────────────────
    const flashFee       = inputTokenB * (FLASH_FEE_PCT / 100);
    const quoterUsed     = buyQuoterUsed || sellQuoterUsed;
    const appliedSafety  = quoterUsed ? 1.0 : safetyFactor;
    const profitTokenB   = (tokenBReceived - inputTokenB - flashFee) * appliedSafety;
    const profitUSD      = profitTokenB * tokenBPriceUSD;

    // v2.1 FIX: Subtract estimated gas. Only sizes profitable after gas advance.
    const profitAfterGasUSD = profitUSD - ESTIMATED_GAS_USD;
    if (profitAfterGasUSD <= 0) continue;

    if (profitAfterGasUSD > best.profitAfterGasUSD) {
      best = { size: usdSize, profitUSD, profitAfterGasUSD, isEstimate: isV3Trade && !quoterUsed, quoterUsed, buyQuoterUsed, sellQuoterUsed };
    }
  }
  return best;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SCAN A SINGLE PAIR (WebSocket trigger path)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function scanPair(pairPools) {
  if (!pairPools || pairPools.length < 2) return null;

  const poolDataRaw = await Promise.all(
    pairPools.map(p => p.type === 'V3' ? getV3PoolData(p) : getV2PoolData(p))
  );
  const poolData = poolDataRaw.filter(p =>
    p !== null &&
    p.liquidityUSD >= (p.minLiquidity || MIN_LIQUIDITY_USD) &&
    isFinite(p.price) && p.price > 0
  );
  if (poolData.length < 2) return null;

  const pairName = pairPools[0].pair;
  if (pairName === 'WETH/USDC') {
    const ps = poolData.filter(p => p.price > 100).map(p => p.price).sort((a, b) => a - b);
    if (ps.length) ethUsdPrice = ps[Math.floor(ps.length / 2)];
  }
  if (pairName === 'cbBTC/USDC') {
    const ps = poolData.filter(p => p.price > 1000).map(p => p.price).sort((a, b) => a - b);
    if (ps.length) btcUsdPrice = ps[Math.floor(ps.length / 2)];
  }

  const sanePools = filterSanePrices(poolData);
  if (sanePools.length < 2) return null;

  let bestOpp = null;
  for (const buyPool of sanePools) {
    for (const sellPool of sanePools) {
      if (buyPool.address === sellPool.address) continue;
      if (buyPool.price >= sellPool.price) continue;
      // v2.1 FIX: Skip Aerodrome sAMM pools — wrong AMM curve
      if (buyPool.isStable || sellPool.isStable) continue;

      const gapPct = ((sellPool.price - buyPool.price) / buyPool.price) * 100;
      if (gapPct < MIN_GAP_PERCENT || gapPct > 50) continue;

      const totalFeePct = (buyPool.fee * 100) + (sellPool.fee * 100) + FLASH_FEE_PCT;
      if (gapPct - totalFeePct <= 0) continue;

      const { size: bestSize, profitUSD, profitAfterGasUSD, isEstimate, quoterUsed, buyQuoterUsed, sellQuoterUsed } =
        await findBestTradeSize(buyPool, sellPool);
      if (profitAfterGasUSD <= 0) continue;

      if (!bestOpp || profitAfterGasUSD > bestOpp.profitAfterGasUSD) {
        bestOpp = { pairName, buyPool, sellPool, gapPct, bestSize, profitUSD, profitAfterGasUSD, pools: sanePools, isEstimate, quoterUsed, buyQuoterUsed, sellQuoterUsed };
      }
    }
  }
  return bestOpp;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN HEARTBEAT SCAN (all pools every 2min)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function scan(allPools) {
  console.log(`\n[${new Date().toISOString()}] 💓 Heartbeat — ${allPools.length} pools...`);

  const poolDataRaw = [];
  const BATCH = 20;
  for (let i = 0; i < allPools.length; i += BATCH) {
    const batch   = allPools.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(p => p.type === 'V3' ? getV3PoolData(p) : getV2PoolData(p)));
    poolDataRaw.push(...results);
    if (i + BATCH < allPools.length) await sleep(400);
  }

  const wethPools = poolDataRaw.filter(p => p && p.pair === 'WETH/USDC' && p.price > 100);
  if (wethPools.length) {
    const ps = wethPools.map(p => p.price).sort((a, b) => a - b);
    ethUsdPrice = ps[Math.floor(ps.length / 2)];
    console.log(`  📊 ETH: $${ethUsdPrice.toFixed(2)}`);
  }
  const btcPools = poolDataRaw.filter(p => p && p.pair === 'cbBTC/USDC' && p.price > 1000);
  if (btcPools.length) {
    const ps = btcPools.map(p => p.price).sort((a, b) => a - b);
    btcUsdPrice = ps[Math.floor(ps.length / 2)];
    console.log(`  📊 BTC: $${btcUsdPrice.toFixed(2)}`);
  }

  for (const p of poolDataRaw) {
    if (p && p.liquidityUSD === 0) p.liquidityUSD = computeLiquidityUSD(p, p.x, p.y);
  }

  const nullCount = poolDataRaw.filter(p => p === null).length;
  const nonNull   = poolDataRaw.filter(p => p !== null);
  const poolData  = nonNull.filter(p =>
    p.liquidityUSD >= (p.minLiquidity || MIN_LIQUIDITY_USD) &&
    isFinite(p.price) && p.price > 0
  );

  const liqValues = poolData.map(p => Math.round(p.liquidityUSD));
  const maxLiq    = liqValues.length ? Math.max(...liqValues) : 0;
  const minLiq    = liqValues.length ? Math.min(...liqValues) : 0;
  console.log(`  🔍 ${nullCount} null | ${nonNull.length} got data | liq $${minLiq.toLocaleString()}–$${maxLiq.toLocaleString()}`);

  // Group by pair
  const groups = {};
  for (const pool of poolData) {
    if (!groups[pool.pair]) groups[pool.pair] = [];
    groups[pool.pair].push(pool);
  }

  const fmtLiq = v => v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${Math.round(v)}`;
  for (const [pairName, pairPools] of Object.entries(groups)) {
    const sorted = [...pairPools].sort((a, b) => a.price - b.price);
    const rawGap = sorted.length >= 2
      ? ((sorted[sorted.length - 1].price - sorted[0].price) / sorted[0].price * 100).toFixed(3)
      : '0.000';
    console.log(`\n  ┌── ${pairName} │ ${sorted.length} pools │ raw gap: ${rawGap}%`);
    for (const p of sorted) {
      const stableTag = p.isStable ? ' 🚫excl' : '';
      const v3Tag     = p.isV3 ? ' 🟡' : '';
      console.log(`  │  ${p.dex.padEnd(32)} $${p.price.toFixed(4).padEnd(10)} fee:${(p.fee * 100).toFixed(2)}% Liq:${fmtLiq(p.liquidityUSD)}${v3Tag}${stableTag}`);
    }
    console.log(`  └─────────────────────────────────────────────────────`);
  }

  const opportunities = [];

  for (const [pairName, pools] of Object.entries(groups)) {
    if (pools.length < 2) continue;
    const sanePools = filterSanePrices(pools);
    if (sanePools.length < 2) continue;

    let bestOpp = null, mostPromising = null;

    for (const buyPool of sanePools) {
      for (const sellPool of sanePools) {
        if (buyPool.address === sellPool.address) continue;
        if (buyPool.price >= sellPool.price) continue;
        // v2.1 FIX: Skip Aerodrome sAMM
        if (buyPool.isStable || sellPool.isStable) continue;

        const gapPct      = ((sellPool.price - buyPool.price) / buyPool.price) * 100;
        if (gapPct < MIN_GAP_PERCENT || gapPct > 50) continue;

        const totalFeePct = (buyPool.fee * 100) + (sellPool.fee * 100) + FLASH_FEE_PCT;
        const netPct      = gapPct - totalFeePct;

        if (!mostPromising || netPct > mostPromising.netPct) {
          mostPromising = { buyPool, sellPool, gapPct, totalFeePct, netPct };
        }
        if (netPct <= 0) continue;

        const { size: bestSize, profitUSD, profitAfterGasUSD, isEstimate, quoterUsed, buyQuoterUsed, sellQuoterUsed } =
          await findBestTradeSize(buyPool, sellPool);
        if (profitAfterGasUSD <= 0) continue;

        if (!bestOpp || profitAfterGasUSD > bestOpp.profitAfterGasUSD) {
          bestOpp = { pairName, buyPool, sellPool, gapPct, bestSize, profitUSD, profitAfterGasUSD, pools: sanePools, isEstimate, quoterUsed, buyQuoterUsed, sellQuoterUsed };
        }
      }
    }

    if (!bestOpp) {
      if (mostPromising) {
        const s = mostPromising.netPct > 0 ? '+' : '';
        console.log(`  ❌ ${pairName}: gap=${mostPromising.gapPct.toFixed(3)}% fees=${mostPromising.totalFeePct.toFixed(2)}% net=${s}${mostPromising.netPct.toFixed(3)}%`);
      }
      continue;
    }

    opportunities.push(bestOpp);
    console.log(`  ✅ ${pairName} | ${bestOpp.buyPool.dex} → ${bestOpp.sellPool.dex} | $${bestOpp.bestSize.toLocaleString()} | gross $${bestOpp.profitUSD.toFixed(2)} → net $${bestOpp.profitAfterGasUSD.toFixed(2)}${bestOpp.isEstimate ? ' (est)' : ''}${bestOpp.quoterUsed ? ' ✅Q' : ''}`);
  }

  return {
    opportunities,
    scanMeta: {
      nullCount, belowThreshold: nonNull.length - poolData.length,
      activePools: poolData.length, poolsFound: poolDataRaw.length,
      poolPrices: poolData.map(p => ({
        pair: p.pair, dex: p.dex, price: parseFloat(p.price.toFixed(4)),
        tvl: Math.round(p.liquidityUSD), type: p.isV3 ? 'V3' : 'V2', isStable: p.isStable || false,
      })),
    },
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TELEGRAM
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function formatAlert(opp) {
  const allPrices = opp.pools
    .filter(p => !p.isStable)
    .sort((a, b) => a.price - b.price)
    .map(p => `${p.dex}: $${p.price.toFixed(4)} | Liq: $${Math.round(p.liquidityUSD).toLocaleString()}${p.isV3 ? ' 🟡' : ' 💧'}`)
    .join('\n');

  // Per-leg method label — shows exactly what data each leg used
  const buyMethod  = opp.buyPool.type  === 'V3' ? (opp.buyQuoterUsed  ? '✅ Quoter' : '~slot0 est') : 'V2 exact';
  const sellMethod = opp.sellPool.type === 'V3' ? (opp.sellQuoterUsed ? '✅ Quoter' : '~slot0 est') : 'V2 exact';

  return `🟢 <b>ARB SIGNAL — ${opp.pairName}</b>

📐 Gap: <b>${opp.gapPct.toFixed(3)}%</b>

🔻 <b>BUY</b> ${opp.buyPool.dex}
   Price: $${opp.buyPool.price.toFixed(6)}
   Liq: $${Math.round(opp.buyPool.liquidityUSD).toLocaleString()}${opp.buyPool.isV3 ? ' 🟡active' : ''}
   Data: ${buyMethod}

🔺 <b>SELL</b> ${opp.sellPool.dex}
   Price: $${opp.sellPool.price.toFixed(6)}
   Liq: $${Math.round(opp.sellPool.liquidityUSD).toLocaleString()}${opp.sellPool.isV3 ? ' 🟡active' : ''}
   Data: ${sellMethod}

💰 <b>Size:</b> $${opp.bestSize.toLocaleString()}
💵 <b>Gross profit:</b> $${opp.profitUSD.toFixed(2)}${profitNote}
⛽ <b>Gas (est.):</b> -$${ESTIMATED_GAS_USD.toFixed(2)}
✅ <b>Net profit:</b> $${opp.profitAfterGasUSD.toFixed(2)}
   (after DEX fees + ${FLASH_LOAN_PROTOCOL} ${FLASH_FEE_PCT}% flash + gas)

🏪 <b>All pools:</b>
${allPrices}

⚡ <b>Trigger:</b> ${opp.trigger || 'heartbeat'}
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
// GOOGLE SHEETS LOGGER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function logToSheets(data) {
  if (!SHEETS_WEBHOOK_URL) return;
  try {
    const res  = await fetch(SHEETS_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
    const text = await res.text();
    if (text !== 'OK') console.log(`  📊 Sheets: ${text.slice(0, 100)}`);
  } catch (e) { console.log(`  📊 Sheets FAILED: ${e.message}`); }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HANDLE OPPORTUNITY
//
// v2.1 CHANGE: Cooldown key = pair + buyDex + sellDex
// Old: one cooldown for all WETH/USDC routes → missed second valid route
// New: each unique DEX combo gets its own 10min cooldown independently
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleOpportunity(opp) {
  const now         = Date.now();
  const cooldownKey = `${opp.pairName}|${opp.buyPool.dex}|${opp.sellPool.dex}`;
  const lastAlert   = lastAlertTime.get(cooldownKey) || 0;
  if (now - lastAlert < ALERT_COOLDOWN_MS) {
    const minsLeft = Math.ceil((ALERT_COOLDOWN_MS - (now - lastAlert)) / 60000);
    console.log(`  ⏳ ${cooldownKey}: cooldown ${minsLeft}min left`);
    return;
  }
  lastAlertTime.set(cooldownKey, now);
  await sendTelegram(formatAlert(opp));
  logToSheets({
    timestamp: new Date().toISOString(),
    type: 'signal',
    trigger: opp.trigger || 'heartbeat',
    pair: opp.pairName,
    gap: opp.gapPct.toFixed(3),
    buyDex: opp.buyPool.dex,
    buyPrice: opp.buyPool.price.toFixed(4),
    sellDex: opp.sellPool.dex,
    sellPrice: opp.sellPool.price.toFixed(4),
    size: opp.bestSize,
    profitGross: opp.profitUSD.toFixed(2),
    estimatedGasUSD: ESTIMATED_GAS_USD,
    profitNet: opp.profitAfterGasUSD.toFixed(2),
    isEstimate: opp.isEstimate,
    quoterUsed: opp.quoterUsed || false,
    buyLegMethod: opp.buyPool.type === 'V3' ? (opp.buyQuoterUsed ? 'quoter' : 'slot0_estimate') : 'v2_exact',
    sellLegMethod: opp.sellPool.type === 'V3' ? (opp.sellQuoterUsed ? 'quoter' : 'slot0_estimate') : 'v2_exact',
    flashProtocol: FLASH_LOAN_PROTOCOL,
    ethPrice: ethUsdPrice,
    btcPrice: btcUsdPrice,
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WEBSOCKET SCANNING
//
// v2.1 changes:
//   - Per-pair debounce: waits 2s of silence before scanning
//     Prevents RPC storms when WETH/USDC fires 100 swaps/second
//   - Reconnect guard (isReconnecting flag): prevents multiple overlapping
//     reconnect loops if both 'error' and 'close' events fire together
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let wssProvider       = null;
let wssListeners      = [];
let wssDisconnectCount = 0;
let isReconnecting    = false; // v2.1: guard flag

async function startWebSocket(allPools) {
  const pairGroups = {};
  for (const pool of allPools) {
    if (!pairGroups[pool.pair]) pairGroups[pool.pair] = [];
    pairGroups[pool.pair].push(pool);
  }

  const connect = async () => {
    console.log(`\n⚡ Connecting WebSocket: ${WSS_URL}...`);
    try {
      wssProvider = new ethers.WebSocketProvider(WSS_URL);
      await wssProvider.ready;
      console.log('⚡ WebSocket connected. Subscribing to Swap events...');
      isReconnecting = false;
      wssListeners   = [];

      for (const pool of allPools) {
        const abi      = pool.type === 'V3' ? V3_POOL_ABI : V2_POOL_SWAP_ABI;
        const contract = new ethers.Contract(pool.address, abi, wssProvider);

        const handler = async () => {
          const pairKey = pool.pair;

          // v2.1 FIX: Debounce per pair
          // Cancel existing timer for this pair and restart 2s countdown
          if (pairDebounceTimers.has(pairKey)) {
            clearTimeout(pairDebounceTimers.get(pairKey));
          }
          pairDebounceTimers.set(pairKey, setTimeout(async () => {
            pairDebounceTimers.delete(pairKey);
            try {
              console.log(`  ⚡ Debounced scan: ${pairKey} (via ${pool.dex})`);
              const opp = await scanPair(pairGroups[pairKey]);
              if (opp) {
                opp.trigger = `WebSocket: ${pool.dex}`;
                await handleOpportunity(opp);
              }
            } catch (e) { console.error(`  WSS scan error: ${e.message}`); }
          }, WSS_PAIR_DEBOUNCE_MS));
        };

        contract.on('Swap', handler);
        wssListeners.push({ contract, handler });
      }

      console.log(`⚡ Subscribed to ${allPools.length} pool Swap events.\n`);

      // Disconnect handler
      const onDisconnect = async () => {
        // v2.1 FIX: Guard prevents double reconnect if both error+close fire
        if (isReconnecting) return;
        isReconnecting = true;
        wssDisconnectCount++;
        const ts = new Date().toISOString();
        console.log(`\n🔌 WebSocket disconnected #${wssDisconnectCount} at ${ts}`);

        sendTelegram(`🔌 <b>WebSocket Disconnected</b>\nReconnecting in ${WSS_RECONNECT_MS / 1000}s...\nDisconnect #${wssDisconnectCount}\nTime: ${ts}`);
        logToSheets({ timestamp: ts, type: 'wss_disconnect', disconnectCount: wssDisconnectCount, message: 'WebSocket dropped' });

        for (const { contract, handler } of wssListeners) {
          try { contract.off('Swap', handler); } catch (_) {}
        }
        wssListeners = [];

        await sleep(WSS_RECONNECT_MS);
        connect();
      };

      wssProvider.websocket.on('close', onDisconnect);
      wssProvider.websocket.on('error', (err) => {
        // Log error but don't trigger reconnect — 'close' will follow
        console.error(`  WSS error: ${err.message}`);
      });

    } catch (e) {
      if (!isReconnecting) {
        isReconnecting = true;
        console.error(`⚡ Connect failed: ${e.message}. Retrying in ${WSS_RECONNECT_MS / 1000}s...`);
        await sleep(WSS_RECONNECT_MS);
        isReconnecting = false;
        connect();
      }
    }
  };

  connect();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Ghost Arb Monitor v2.1                 ║');
  console.log('║   4 Critical Fixes from 6-AI Audit       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`RPC:      ${RPC_URL}`);
  console.log(`WSS:      ${WSS_URL}`);
  console.log(`Flash:    ${FLASH_LOAN_PROTOCOL} (${FLASH_FEE_PCT}% fee)`);
  console.log(`Gas est:  $${ESTIMATED_GAS_USD} per tx`);
  console.log(`Min gap:  ${MIN_GAP_PERCENT}% | Min liq: $${MIN_LIQUIDITY_USD.toLocaleString()}`);
  console.log(`Heartbeat: ${SCAN_INTERVAL_MS / 1000}s | WSS debounce: ${WSS_PAIR_DEBOUNCE_MS}ms`);

  if (SHEETS_WEBHOOK_URL) {
    console.log('📊 Testing Google Sheets...');
    await logToSheets({ timestamp: new Date().toISOString(), type: 'startup', message: 'Ghost Arb Monitor v2.1 connected' });
  }

  const allPools = await discoverAllPools();
  if (!allPools.length) { console.error('❌ No pools found. Check RPC.'); process.exit(1); }

  await sendTelegram(`🤖 <b>Ghost Arb Monitor v2.1 LIVE</b>

🔧 <b>4 Critical Fixes (6-AI Audit):</b>
1. 🎯 V3 Quoter: Uniswap pools only (Sushi/Pancake now use slot0 fallback — no fake quotes)
2. 🚫 Aerodrome sAMM: excluded from arb (wrong curve — x³y+y³x≠x*y)
3. 🔢 BigInt precision: V3 prices now accurate at 0.3% margins
4. ⛽ Gas deducted: -$${ESTIMATED_GAS_USD} from every profit estimate

⚡ WSS debounce per pair: ${WSS_PAIR_DEBOUNCE_MS}ms
🔒 Reconnect guard: no more duplicate loops
🔑 Cooldown per route (pair+buyDex+sellDex)

✅ <b>${allPools.length} pools</b> | ${allPools.filter(p => p.isStable).length} sAMM excluded
WSS: ${WSS_URL}`);

  await startWebSocket(allPools);

  let isScanning = false;
  const run = async () => {
    if (isScanning) { console.log('  ⏭️  Previous heartbeat still running.'); return; }
    isScanning = true;
    try {
      const { opportunities: opps, scanMeta } = await scan(allPools);
      logToSheets({
        timestamp: new Date().toISOString(),
        type: 'heartbeat',
        ethPrice: ethUsdPrice, btcPrice: btcUsdPrice,
        poolsFound: scanMeta.poolsFound, rpcFailed: scanMeta.nullCount,
        activePools: scanMeta.activePools, estimatedGasUSD: ESTIMATED_GAS_USD,
        flashProtocol: FLASH_LOAN_PROTOCOL,
        bestPair: opps.length ? opps[0].pairName : null,
        decision: opps.length ? 'signal' : 'no opportunity',
        pools: scanMeta.poolPrices,
      });
      for (const opp of opps) {
        opp.trigger = 'heartbeat';
        await handleOpportunity(opp);
        await sleep(500);
      }
    } catch (e) { console.error('Heartbeat error:', e.message); }
    finally { isScanning = false; }
  };

  const scheduleNext = () => setTimeout(async () => { await run(); scheduleNext(); }, SCAN_INTERVAL_MS);
  await run();
  scheduleNext();
}

main().catch(console.error);
