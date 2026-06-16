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

const MIN_GAP_PERCENT    = parseFloat(process.env.MIN_GAP_PERCENT   || '0.2'); // lowered 0.3→0.2 to catch more signals
const MIN_LIQUIDITY_USD  = parseFloat(process.env.MIN_LIQUIDITY_USD || '10000');
const SCAN_INTERVAL_MS   = parseInt(process.env.SCAN_INTERVAL_MS    || '600000'); // 10min heartbeat (was 2min)
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || '';
const ESTIMATED_GAS_USD  = parseFloat(process.env.ESTIMATED_GAS_USD || '2');

// v2.2 WSS reconnect — exponential backoff constants
const WSS_RECONNECT_BASE_MS = 15000;  // start at 15s
const WSS_RECONNECT_MAX_MS  = 300000; // cap at 5 minutes
const WSS_SPAM_THRESHOLD    = 5;      // silence Telegram after this many consecutive failures

// v2.2 WebSocket pair debounce
const WSS_PAIR_DEBOUNCE_MS = 2000;

const provider = new ethers.JsonRpcProvider(RPC_URL);

const FLASH_LOAN_PROTOCOL = process.env.FLASH_LOAN_PROTOCOL || 'BALANCER';
const FLASH_FEE_PCT = FLASH_LOAN_PROTOCOL === 'AAVE' ? 0.09 : 0.0;

// v2.1: cooldown per route
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
  WETH:    { address: '0x4200000000000000000000000000000000000006', decimals: 18, symbol: 'WETH'    },
  USDC:    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6,  symbol: 'USDC'    },
  USDT:    { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6,  symbol: 'USDT'    },
  DAI:     { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18, symbol: 'DAI'     },
  cbETH:   { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18, symbol: 'cbETH'   },
  WBTC:    { address: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', decimals: 8,  symbol: 'WBTC'    },
  cbBTC:   { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8,  symbol: 'cbBTC'   },
  BRETT:   { address: '0x532f27101965dd16442E59d40670FaF5eBb142E4', decimals: 18, symbol: 'BRETT'   },
  DEGEN:   { address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', decimals: 18, symbol: 'DEGEN'   },
  TOSHI:   { address: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4', decimals: 18, symbol: 'TOSHI'   },
  // v2.2 NEW PAIRS — less liquid, less aggregator competition
  AERO:    { address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', decimals: 18, symbol: 'AERO'    },
  VIRTUAL: { address: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', decimals: 18, symbol: 'VIRTUAL' },
  MOG:     { address: '0x2Da56AcB9Ea78330f947bD57C54119Debda7AF71', decimals: 18, symbol: 'MOG'     },
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
// PAIRS TO WATCH
//
// v2.2: Added 3 new pairs — AERO, VIRTUAL, MOG
// These are Base-native volatile tokens with lower liquidity.
// LESS bot competition than WETH/USDC. More likely to have
// gaps that last long enough to catch.
// minLiquidity set lower (5000) to capture smaller pools.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const WATCH_PAIRS = [
  // Original 12
  { name: 'WETH/USDC',    tokenA: TOKENS.WETH,  tokenB: TOKENS.USDC,  minLiquidity: 50000 },
  { name: 'WETH/USDT',    tokenA: TOKENS.WETH,  tokenB: TOKENS.USDT,  minLiquidity: 50000 },
  { name: 'USDC/USDT',    tokenA: TOKENS.USDC,  tokenB: TOKENS.USDT,  minLiquidity: 50000 },
  { name: 'DAI/USDC',     tokenA: TOKENS.DAI,   tokenB: TOKENS.USDC,  minLiquidity: 50000 },
  { name: 'cbETH/WETH',   tokenA: TOKENS.cbETH, tokenB: TOKENS.WETH,  minLiquidity: 50000 },
  { name: 'WBTC/WETH',    tokenA: TOKENS.WBTC,  tokenB: TOKENS.WETH,  minLiquidity: 50000 },
  { name: 'cbBTC/WBTC',   tokenA: TOKENS.cbBTC, tokenB: TOKENS.WBTC,  minLiquidity: 50000 },
  { name: 'cbBTC/WETH',   tokenA: TOKENS.cbBTC, tokenB: TOKENS.WETH,  minLiquidity: 50000 },
  { name: 'cbBTC/USDC',   tokenA: TOKENS.cbBTC, tokenB: TOKENS.USDC,  minLiquidity: 50000 },
  { name: 'BRETT/WETH',   tokenA: TOKENS.BRETT, tokenB: TOKENS.WETH,  minLiquidity: 50000 },
  { name: 'DEGEN/WETH',   tokenA: TOKENS.DEGEN, tokenB: TOKENS.WETH,  minLiquidity: 50000 },
  { name: 'TOSHI/WETH',   tokenA: TOKENS.TOSHI, tokenB: TOKENS.WETH,  minLiquidity: 50000 },
  // v2.2 NEW — volatile Base-native tokens
  { name: 'AERO/WETH',    tokenA: TOKENS.AERO,  tokenB: TOKENS.WETH,  minLiquidity: 5000  },
  { name: 'AERO/USDC',    tokenA: TOKENS.AERO,  tokenB: TOKENS.USDC,  minLiquidity: 5000  },
  { name: 'VIRTUAL/WETH', tokenA: TOKENS.VIRTUAL,tokenB: TOKENS.WETH, minLiquidity: 5000  },
  { name: 'MOG/WETH',     tokenA: TOKENS.MOG,   tokenB: TOKENS.WETH,  minLiquidity: 5000  },
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
// V3 QUOTER (Uniswap only)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const QUOTER_ADDRESS = '0x3d4e44Eb1374240CE5F1B136aa68B6a741f674F7';
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];
const quoterContract = new ethers.Contract(QUOTER_ADDRESS, QUOTER_ABI, provider);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PRICE HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Adaptive bit-shifting — correct for all price ranges (v2.1 patch)
function sqrtPriceX96ToHumanPrice(sqrtPriceX96BN, isTokenAToken0, tokenADec, tokenBDec) {
  if (!sqrtPriceX96BN || sqrtPriceX96BN === 0n) return null;
  let s = sqrtPriceX96BN;
  let e = 0;
  while (s >= (1n << 27n)) { s >>= 1n; e++; }
  const sNum     = Number(s);
  const sq       = sNum * sNum;
  const exp      = 192 - 2 * e;
  const rawPrice = exp >= 0 ? sq / Math.pow(2, exp) : sq * Math.pow(2, -exp);
  if (!rawPrice || !isFinite(rawPrice)) return null;
  const decimalFactor = Math.pow(10, tokenADec - tokenBDec);
  return isTokenAToken0 ? rawPrice * decimalFactor : decimalFactor / rawPrice;
}

function getTokenUsdPrice(symbol) {
  if (['USDC', 'USDT', 'DAI'].includes(symbol)) return 1;
  if (['WETH', 'cbETH'].includes(symbol)) return ethUsdPrice;
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

function filterSanePrices(pools) {
  if (pools.length <= 2) return pools;
  const prices = pools.map(p => p.price).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  return pools.filter(p => {
    const ratio = p.price / median;
    const sane  = ratio > 0.5 && ratio < 2.0;
    if (!sane) console.log(`  ⚠️  Filtered: ${p.dex} @ ${p.price.toFixed(6)} (median: ${median.toFixed(6)})`);
    return sane;
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// POOL DISCOVERY
//
// v2.2 FIX — token0 caching:
// token0 is the "lower address" token in a pool. It NEVER changes.
// Old code called token0() on EVERY scan — 167 pools × every heartbeat
// = hundreds of thousands of wasted RPC calls per day.
// Fix: call token0() ONCE during discovery, store as pool.cachedToken0.
// Scan functions use the cached value — zero token0 RPC calls during scanning.
// Saves ~33% of all RPC calls.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function discoverAllPools() {
  console.log('\n🔍 Discovering pools + caching token0...');
  const allPools = [];
  const ZERO    = '0x0000000000000000000000000000000000000000';

  for (const pair of WATCH_PAIRS) {
    console.log(`\n  Pair: ${pair.name}`);
    for (const factory of FACTORIES) {
      try {
        if (factory.type === 'V2') {
          const contract = new ethers.Contract(factory.address, V2_FACTORY_ABI, provider);
          const addr = await contract.getPair(pair.tokenA.address, pair.tokenB.address);
          if (addr && addr !== ZERO) {
            // v2.2: cache token0 at discovery
            const poolContract = new ethers.Contract(addr, V2_POOL_ABI, provider);
            const cachedToken0 = await poolContract.token0();
            allPools.push({
              pair: pair.name, dex: factory.name, type: 'V2', address: addr,
              tokenA: pair.tokenA, tokenB: pair.tokenB, fee: 0.003,
              minLiquidity: pair.minLiquidity, isStable: false,
              isUniswapV3: false, cachedToken0,
            });
            console.log(`    ✅ ${factory.name}: ${addr}`);
          }
        }

        if (factory.type === 'V3') {
          const contract = new ethers.Contract(factory.address, V3_FACTORY_ABI, provider);
          for (const fee of factory.feeTiers) {
            const addr = await contract.getPool(pair.tokenA.address, pair.tokenB.address, fee);
            if (addr && addr !== ZERO) {
              const poolContract = new ethers.Contract(addr, V3_POOL_ABI, provider);
              const cachedToken0 = await poolContract.token0();
              allPools.push({
                pair: pair.name, dex: `${factory.name} ${fee / 10000}%`, type: 'V3',
                address: addr, tokenA: pair.tokenA, tokenB: pair.tokenB,
                fee: fee / 1000000, v3FeeTier: fee,
                minLiquidity: pair.minLiquidity, isStable: false,
                isUniswapV3: factory.name === 'Uniswap V3',
                cachedToken0,
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
              const poolContract = new ethers.Contract(addr, V2_POOL_ABI, provider);
              const cachedToken0 = await poolContract.token0();
              allPools.push({
                pair: pair.name, dex: `Aerodrome ${stable ? 'sAMM' : 'vAMM'}`,
                type: 'V2', address: addr, tokenA: pair.tokenA, tokenB: pair.tokenB,
                fee: stable ? 0.0001 : 0.003, minLiquidity: pair.minLiquidity,
                isStable: stable, isUniswapV3: false, cachedToken0,
              });
              const tag = stable ? '⚠️ sAMM (excluded from arb)' : 'vAMM';
              console.log(`    ✅ Aerodrome ${tag}: ${addr}`);
            }
          }
        }
      } catch (e) { /* pool doesn't exist */ }
      await sleep(500);
    }
  }

  const stableCount = allPools.filter(p => p.isStable).length;
  console.log(`\n✅ Found ${allPools.length} pools (${stableCount} sAMM excluded). token0 cached for all.\n`);
  return allPools;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GET V2 POOL DATA
// v2.2: uses cachedToken0 — no token0() RPC call
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function getV2PoolData(pool) {
  try {
    const contract  = new ethers.Contract(pool.address, V2_POOL_ABI, provider);
    const reserves  = await contract.getReserves(); // only 1 call now (was 2)
    const token0Addr = pool.cachedToken0;           // v2.2: from cache, not RPC

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
// v2.2: uses cachedToken0 — no token0() RPC call
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function getV3PoolData(pool) {
  try {
    const contract = new ethers.Contract(pool.address, V3_POOL_ABI, provider);
    const [slot0Data, liquidityRaw] = await Promise.all([
      contract.slot0(), contract.liquidity(),  // only 2 calls now (was 3)
    ]);
    const token0Addr   = pool.cachedToken0;  // v2.2: from cache
    const sqrtPriceX96 = slot0Data[0];
    if (sqrtPriceX96 === 0n || liquidityRaw === 0n) return null;

    const isTokenAToken0 = token0Addr.toLowerCase() === pool.tokenA.address.toLowerCase();
    const price = sqrtPriceX96ToHumanPrice(sqrtPriceX96, isTokenAToken0, pool.tokenA.decimals, pool.tokenB.decimals);
    if (!price || price <= 0 || !isFinite(price)) return null;

    const Q96       = 2n ** 96n;
    const x0_raw_bn = (liquidityRaw * Q96) / sqrtPriceX96;
    const y0_raw_bn = (liquidityRaw * sqrtPriceX96) / Q96;

    const safeToFloat = (bn, decimals) => {
      const scale = BigInt(10 ** decimals);
      return Number(bn / scale) + Number(bn % scale) / (10 ** decimals);
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
// V3 QUOTER (Uniswap V3 only)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function getV3Quote(pool, inputAmountHuman, buyingTokenA) {
  if (!pool.isUniswapV3 || !pool.v3FeeTier) return null;
  try {
    const tokenIn     = buyingTokenA ? pool.tokenB.address : pool.tokenA.address;
    const tokenOut    = buyingTokenA ? pool.tokenA.address : pool.tokenB.address;
    const decimalsIn  = buyingTokenA ? pool.tokenB.decimals : pool.tokenA.decimals;
    const decimalsOut = buyingTokenA ? pool.tokenA.decimals : pool.tokenB.decimals;
    const amountIn    = ethers.parseUnits(inputAmountHuman.toFixed(decimalsIn), decimalsIn);
    const result      = await quoterContract.quoteExactInputSingle.staticCall({
      tokenIn, tokenOut, amountIn, fee: pool.v3FeeTier, sqrtPriceLimitX96: 0n,
    });
    return parseFloat(ethers.formatUnits(result[0], decimalsOut));
  } catch (e) { return null; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SIMULATE TRADE (V2 x*y=k)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function simulateTrade(pool, inputAmount, buyingTokenA) {
  const { x, y, k, fee } = pool;
  const inputAfterFee = inputAmount * (1 - fee);
  if (buyingTokenA) { const newY = y + inputAfterFee; return x - k / newY; }
  else              { const newX = x + inputAfterFee; return y - k / newX; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FIND BEST TRADE SIZE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function findBestTradeSize(buyPool, sellPool) {
  const USD_SIZES      = [1000, 5000, 10000, 25000, 50000, 100000, 200000, 500000];
  const isV3Trade      = buyPool.type === 'V3' || sellPool.type === 'V3';
  const maxFraction    = isV3Trade ? 0.05 : 0.10;
  const safetyFactor   = isV3Trade ? 0.80 : 1.00;
  const tokenBPriceUSD = getTokenUsdPrice(buyPool.tokenB.symbol) || 1;

  let best = { size: 0, profitUSD: 0, profitAfterGasUSD: 0, isEstimate: isV3Trade, quoterUsed: false, buyQuoterUsed: false, sellQuoterUsed: false };

  for (const usdSize of USD_SIZES) {
    const inputTokenB = usdSize / tokenBPriceUSD;
    if (inputTokenB > buyPool.y * maxFraction) continue;

    let tokenAReceived, buyQuoterUsed = false;
    if (buyPool.type === 'V3') {
      const q = await getV3Quote(buyPool, inputTokenB, true);
      if (q && q > 0) { tokenAReceived = q; buyQuoterUsed = true; }
      else tokenAReceived = simulateTrade(buyPool, inputTokenB, true);
    } else { tokenAReceived = simulateTrade(buyPool, inputTokenB, true); }
    if (!tokenAReceived || tokenAReceived <= 0 || tokenAReceived > sellPool.x * maxFraction) continue;

    let tokenBReceived, sellQuoterUsed = false;
    if (sellPool.type === 'V3') {
      const q = await getV3Quote(sellPool, tokenAReceived, false);
      if (q && q > 0) { tokenBReceived = q; sellQuoterUsed = true; }
      else tokenBReceived = simulateTrade(sellPool, tokenAReceived, false);
    } else { tokenBReceived = simulateTrade(sellPool, tokenAReceived, false); }
    if (!tokenBReceived || tokenBReceived <= 0) continue;

    const flashFee        = inputTokenB * (FLASH_FEE_PCT / 100);
    const quoterUsed      = buyQuoterUsed || sellQuoterUsed;
    const appliedSafety   = quoterUsed ? 1.0 : safetyFactor;
    const profitTokenB    = (tokenBReceived - inputTokenB - flashFee) * appliedSafety;
    const profitUSD       = profitTokenB * tokenBPriceUSD;
    const profitAfterGasUSD = profitUSD - ESTIMATED_GAS_USD;
    if (profitAfterGasUSD <= 0) continue;

    if (profitAfterGasUSD > best.profitAfterGasUSD) {
      best = { size: usdSize, profitUSD, profitAfterGasUSD, isEstimate: isV3Trade && !quoterUsed, quoterUsed, buyQuoterUsed, sellQuoterUsed };
    }
  }
  return best;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SCAN A SINGLE PAIR
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function scanPair(pairPools) {
  if (!pairPools || pairPools.length < 2) return null;
  const poolDataRaw = await Promise.all(pairPools.map(p => p.type === 'V3' ? getV3PoolData(p) : getV2PoolData(p)));
  const poolData    = poolDataRaw.filter(p => p && p.liquidityUSD >= (p.minLiquidity || 10000) && isFinite(p.price) && p.price > 0);
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
      if (buyPool.isStable || sellPool.isStable) continue;

      const gapPct      = ((sellPool.price - buyPool.price) / buyPool.price) * 100;
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
// MAIN HEARTBEAT SCAN
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
  if (wethPools.length) { const ps = wethPools.map(p => p.price).sort((a, b) => a - b); ethUsdPrice = ps[Math.floor(ps.length / 2)]; console.log(`  📊 ETH: $${ethUsdPrice.toFixed(2)}`); }
  const btcPools  = poolDataRaw.filter(p => p && p.pair === 'cbBTC/USDC' && p.price > 1000);
  if (btcPools.length)  { const ps = btcPools.map(p => p.price).sort((a, b) => a - b);  btcUsdPrice  = ps[Math.floor(ps.length / 2)]; console.log(`  📊 BTC: $${btcUsdPrice.toFixed(2)}`); }

  for (const p of poolDataRaw) { if (p && p.liquidityUSD === 0) p.liquidityUSD = computeLiquidityUSD(p, p.x, p.y); }

  const nullCount = poolDataRaw.filter(p => p === null).length;
  const nonNull   = poolDataRaw.filter(p => p !== null);
  const poolData  = nonNull.filter(p => p.liquidityUSD >= (p.minLiquidity || 10000) && isFinite(p.price) && p.price > 0);
  console.log(`  🔍 ${nullCount} null | ${nonNull.length} got data | ${poolData.length} above threshold`);

  const groups = {};
  for (const pool of poolData) { if (!groups[pool.pair]) groups[pool.pair] = []; groups[pool.pair].push(pool); }

  const fmtLiq = v => v >= 1e6 ? `$${(v/1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v/1e3).toFixed(1)}k` : `$${Math.round(v)}`;
  for (const [pairName, pairPools] of Object.entries(groups)) {
    const sorted = [...pairPools].sort((a, b) => a.price - b.price);
    const rawGap = sorted.length >= 2 ? ((sorted[sorted.length-1].price - sorted[0].price) / sorted[0].price * 100).toFixed(3) : '0.000';
    console.log(`\n  ┌── ${pairName} │ ${sorted.length} pools │ gap: ${rawGap}%`);
    for (const p of sorted) {
      console.log(`  │  ${p.dex.padEnd(32)} $${p.price.toFixed(6).padEnd(12)} fee:${(p.fee*100).toFixed(2)}% Liq:${fmtLiq(p.liquidityUSD)}${p.isV3?' 🟡':''}${p.isStable?' 🚫':''}`);
    }
    console.log(`  └──────────────────────────────────────────────────────`);
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
        if (buyPool.isStable || sellPool.isStable) continue;
        const gapPct      = ((sellPool.price - buyPool.price) / buyPool.price) * 100;
        if (gapPct < MIN_GAP_PERCENT || gapPct > 50) continue;
        const totalFeePct = (buyPool.fee * 100) + (sellPool.fee * 100) + FLASH_FEE_PCT;
        const netPct      = gapPct - totalFeePct;
        if (!mostPromising || netPct > mostPromising.netPct) mostPromising = { buyPool, sellPool, gapPct, totalFeePct, netPct };
        if (netPct <= 0) continue;
        const { size: bestSize, profitUSD, profitAfterGasUSD, isEstimate, quoterUsed, buyQuoterUsed, sellQuoterUsed } = await findBestTradeSize(buyPool, sellPool);
        if (profitAfterGasUSD <= 0) continue;
        if (!bestOpp || profitAfterGasUSD > bestOpp.profitAfterGasUSD) {
          bestOpp = { pairName, buyPool, sellPool, gapPct, bestSize, profitUSD, profitAfterGasUSD, pools: sanePools, isEstimate, quoterUsed, buyQuoterUsed, sellQuoterUsed };
        }
      }
    }
    if (!bestOpp) {
      if (mostPromising) console.log(`  ❌ ${pairName}: gap=${mostPromising.gapPct.toFixed(3)}% fees=${mostPromising.totalFeePct.toFixed(2)}% net=${mostPromising.netPct > 0 ? '+' : ''}${mostPromising.netPct.toFixed(3)}%`);
      continue;
    }
    opportunities.push(bestOpp);
    console.log(`  ✅ ${pairName} | ${bestOpp.buyPool.dex} → ${bestOpp.sellPool.dex} | $${bestOpp.bestSize.toLocaleString()} | gross $${bestOpp.profitUSD.toFixed(2)} → net $${bestOpp.profitAfterGasUSD.toFixed(2)}`);
  }

  return {
    opportunities,
    scanMeta: {
      nullCount, activePools: poolData.length, poolsFound: poolDataRaw.length,
      belowThreshold: nonNull.length - poolData.length,
      poolPrices: poolData.map(p => ({ pair: p.pair, dex: p.dex, price: parseFloat(p.price.toFixed(6)), tvl: Math.round(p.liquidityUSD), type: p.isV3 ? 'V3' : 'V2', isStable: p.isStable || false })),
    },
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TELEGRAM + SHEETS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function formatAlert(opp) {
  const allPrices = opp.pools.filter(p => !p.isStable).sort((a, b) => a.price - b.price)
    .map(p => `${p.dex}: $${p.price.toFixed(6)} | Liq: $${Math.round(p.liquidityUSD).toLocaleString()}${p.isV3 ? ' 🟡' : ' 💧'}`).join('\n');
  const buyMethod  = opp.buyPool.type  === 'V3' ? (opp.buyQuoterUsed  ? '✅ Quoter' : '~slot0 est') : 'V2 exact';
  const sellMethod = opp.sellPool.type === 'V3' ? (opp.sellQuoterUsed ? '✅ Quoter' : '~slot0 est') : 'V2 exact';

  return `🟢 <b>ARB SIGNAL — ${opp.pairName}</b>

📐 Gap: <b>${opp.gapPct.toFixed(3)}%</b>

🔻 <b>BUY</b> ${opp.buyPool.dex}
   $${opp.buyPool.price.toFixed(6)} | Liq: $${Math.round(opp.buyPool.liquidityUSD).toLocaleString()}${opp.buyPool.isV3?' 🟡':''}
   Data: ${buyMethod}

🔺 <b>SELL</b> ${opp.sellPool.dex}
   $${opp.sellPool.price.toFixed(6)} | Liq: $${Math.round(opp.sellPool.liquidityUSD).toLocaleString()}${opp.sellPool.isV3?' 🟡':''}
   Data: ${sellMethod}

💰 Size: $${opp.bestSize.toLocaleString()}
💵 Gross: $${opp.profitUSD.toFixed(2)}
⛽ Gas: -$${ESTIMATED_GAS_USD.toFixed(2)}
✅ Net: $${opp.profitAfterGasUSD.toFixed(2)}

🏪 <b>All pools:</b>
${allPrices}

⚡ ${opp.trigger || 'heartbeat'} | ⏰ ${new Date().toUTCString()}`;
}

async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('Telegram error:', e.message); }
}

async function logToSheets(data) {
  if (!SHEETS_WEBHOOK_URL) return;
  try {
    const res  = await fetch(SHEETS_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const text = await res.text();
    if (text !== 'OK') console.log(`  📊 Sheets: ${text.slice(0, 80)}`);
  } catch (e) { console.log(`  📊 Sheets FAILED: ${e.message}`); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function handleOpportunity(opp) {
  const now         = Date.now();
  const cooldownKey = `${opp.pairName}|${opp.buyPool.dex}|${opp.sellPool.dex}`;
  const lastAlert   = lastAlertTime.get(cooldownKey) || 0;
  if (now - lastAlert < ALERT_COOLDOWN_MS) { console.log(`  ⏳ ${cooldownKey}: cooldown`); return; }
  lastAlertTime.set(cooldownKey, now);
  await sendTelegram(formatAlert(opp));
  logToSheets({
    timestamp: new Date().toISOString(), type: 'signal', trigger: opp.trigger || 'heartbeat',
    pair: opp.pairName, gap: opp.gapPct.toFixed(3),
    buyDex: opp.buyPool.dex, buyPrice: opp.buyPool.price.toFixed(6),
    sellDex: opp.sellPool.dex, sellPrice: opp.sellPool.price.toFixed(6),
    size: opp.bestSize, profitGross: opp.profitUSD.toFixed(2),
    estimatedGasUSD: ESTIMATED_GAS_USD, profitNet: opp.profitAfterGasUSD.toFixed(2),
    buyLegMethod: opp.buyPool.type === 'V3' ? (opp.buyQuoterUsed ? 'quoter' : 'slot0_estimate') : 'v2_exact',
    sellLegMethod: opp.sellPool.type === 'V3' ? (opp.sellQuoterUsed ? 'quoter' : 'slot0_estimate') : 'v2_exact',
    isEstimate: opp.isEstimate, flashProtocol: FLASH_LOAN_PROTOCOL,
    ethPrice: ethUsdPrice, btcPrice: btcUsdPrice,
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WEBSOCKET SCANNING
//
// v2.2 changes:
//   - Exponential backoff: 15s → 30s → 60s → 120s → 300s (cap)
//   - After WSS_SPAM_THRESHOLD (5) consecutive failures:
//       suppress Telegram disconnect alerts (log to Sheets only)
//   - On successful reconnect after spam threshold:
//       send "✅ Reconnected" Telegram so you know it's back
//   - isReconnecting guard unchanged (prevents duplicate loops)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let wssProvider          = null;
let wssListeners         = [];
let wssDisconnectCount   = 0;
let wssConsecutiveFails  = 0; // v2.2: track consecutive failures
let wssReconnectDelay    = WSS_RECONNECT_BASE_MS; // v2.2: starts at 15s, doubles each fail
let isReconnecting       = false;

async function startWebSocket(allPools) {
  const pairGroups = {};
  for (const pool of allPools) { if (!pairGroups[pool.pair]) pairGroups[pool.pair] = []; pairGroups[pool.pair].push(pool); }

  const connect = async () => {
    console.log(`\n⚡ Connecting WebSocket (delay was ${wssReconnectDelay/1000}s)...`);
    try {
      wssProvider = new ethers.WebSocketProvider(WSS_URL);
      await wssProvider.ready;

      // v2.2: successful connection — reset backoff counters
      const wasSpamming = wssConsecutiveFails >= WSS_SPAM_THRESHOLD;
      wssConsecutiveFails = 0;
      wssReconnectDelay   = WSS_RECONNECT_BASE_MS;
      isReconnecting      = false;
      wssListeners        = [];

      console.log(`⚡ WebSocket connected. Subscribing to ${allPools.length} pools...`);

      // v2.2: if we were in spam-suppressed mode, send a recovery alert
      if (wasSpamming) {
        sendTelegram(`✅ <b>WebSocket Reconnected</b>\nAfter ${wssDisconnectCount} total disconnects\nBack online: ${new Date().toUTCString()}`);
        logToSheets({ timestamp: new Date().toISOString(), type: 'wss_reconnected', disconnectCount: wssDisconnectCount });
      }

      for (const pool of allPools) {
        const abi      = pool.type === 'V3' ? V3_POOL_ABI : V2_POOL_SWAP_ABI;
        const contract = new ethers.Contract(pool.address, abi, wssProvider);

        const handler = async () => {
          const pairKey = pool.pair;
          if (pairDebounceTimers.has(pairKey)) clearTimeout(pairDebounceTimers.get(pairKey));
          pairDebounceTimers.set(pairKey, setTimeout(async () => {
            pairDebounceTimers.delete(pairKey);
            try {
              console.log(`  ⚡ Scan: ${pairKey} (via ${pool.dex})`);
              const opp = await scanPair(pairGroups[pairKey]);
              if (opp) { opp.trigger = `WebSocket: ${pool.dex}`; await handleOpportunity(opp); }
            } catch (e) { console.error(`  WSS scan error: ${e.message}`); }
          }, WSS_PAIR_DEBOUNCE_MS));
        };

        contract.on('Swap', handler);
        wssListeners.push({ contract, handler });
      }

      const onDisconnect = async () => {
        if (isReconnecting) return;
        isReconnecting = true;
        wssDisconnectCount++;
        wssConsecutiveFails++;
        const ts = new Date().toISOString();

        // v2.2: exponential backoff — double delay each failure, cap at max
        wssReconnectDelay = Math.min(wssReconnectDelay * 2, WSS_RECONNECT_MAX_MS);

        console.log(`\n🔌 WSS disconnected #${wssDisconnectCount} (consec: ${wssConsecutiveFails}) | next retry: ${wssReconnectDelay/1000}s`);

        // v2.2: suppress Telegram after threshold — log to Sheets only
        if (wssConsecutiveFails <= WSS_SPAM_THRESHOLD) {
          sendTelegram(`🔌 <b>WebSocket Disconnected</b>\nReconnecting in ${wssReconnectDelay/1000}s...\nDisconnect #${wssDisconnectCount}\nTime: ${ts}`);
        } else {
          console.log(`  📵 Telegram suppressed (${wssConsecutiveFails} consecutive fails > threshold ${WSS_SPAM_THRESHOLD})`);
        }

        logToSheets({ timestamp: ts, type: 'wss_disconnect', disconnectCount: wssDisconnectCount, consecutiveFails: wssConsecutiveFails, nextRetryMs: wssReconnectDelay });

        for (const { contract, handler } of wssListeners) { try { contract.off('Swap', handler); } catch (_) {} }
        wssListeners = [];

        await sleep(wssReconnectDelay);
        connect();
      };

      wssProvider.websocket.on('close', onDisconnect);
      wssProvider.websocket.on('error', (err) => { console.error(`  WSS error: ${err.message}`); });

    } catch (e) {
      if (!isReconnecting) {
        isReconnecting      = true;
        wssConsecutiveFails++;
        wssReconnectDelay   = Math.min(wssReconnectDelay * 2, WSS_RECONNECT_MAX_MS);
        console.error(`⚡ Connect failed: ${e.message}. Retry in ${wssReconnectDelay/1000}s...`);
        await sleep(wssReconnectDelay);
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
  console.log('║   Ghost Arb Monitor v2.2                 ║');
  console.log('║   RPC savings + Backoff + New pairs      ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`RPC: ${RPC_URL}`);
  console.log(`WSS: ${WSS_URL}`);
  console.log(`Flash: ${FLASH_LOAN_PROTOCOL} | Gas: $${ESTIMATED_GAS_USD} | Min gap: ${MIN_GAP_PERCENT}%`);
  console.log(`Heartbeat: ${SCAN_INTERVAL_MS/1000}s | WSS spam suppressed after ${WSS_SPAM_THRESHOLD} fails`);
  console.log(`Watching ${WATCH_PAIRS.length} pairs (${WATCH_PAIRS.length - 12} new) across ${FACTORIES.length} DEXes`);

  if (SHEETS_WEBHOOK_URL) await logToSheets({ timestamp: new Date().toISOString(), type: 'startup', message: 'Ghost Arb Monitor v2.2 connected' });

  const allPools = await discoverAllPools();
  if (!allPools.length) { console.error('❌ No pools found.'); process.exit(1); }

  await sendTelegram(`🤖 <b>Ghost Arb Monitor v2.2 LIVE</b>

💾 <b>token0 cached</b> — 33% fewer RPC calls
⚡ <b>Exponential backoff</b>: 15s→30s→60s→120s→300s
📵 <b>Disconnect spam</b>: silenced after ${WSS_SPAM_THRESHOLD} fails, Telegram on recovery
📉 <b>Min gap</b>: 0.3% → 0.2% (catch more signals)
⏱ <b>Heartbeat</b>: 2min → 10min (WebSocket still instant)
🆕 <b>New pairs</b>: AERO/WETH, AERO/USDC, VIRTUAL/WETH, MOG/WETH

✅ <b>${allPools.length} pools</b> across ${WATCH_PAIRS.length} pairs
Flash: ${FLASH_LOAN_PROTOCOL} | Gas est: $${ESTIMATED_GAS_USD}`);

  await startWebSocket(allPools);

  let isScanning = false;
  const run = async () => {
    if (isScanning) { console.log('  ⏭️  Previous scan running.'); return; }
    isScanning = true;
    try {
      const { opportunities: opps, scanMeta } = await scan(allPools);
      logToSheets({
        timestamp: new Date().toISOString(), type: 'heartbeat',
        ethPrice: ethUsdPrice, btcPrice: btcUsdPrice,
        poolsFound: scanMeta.poolsFound, rpcFailed: scanMeta.nullCount,
        activePools: scanMeta.activePools, estimatedGasUSD: ESTIMATED_GAS_USD,
        flashProtocol: FLASH_LOAN_PROTOCOL, wssDisconnects: wssDisconnectCount,
        bestPair: opps.length ? opps[0].pairName : null,
        decision: opps.length ? 'signal' : 'no opportunity',
        pools: scanMeta.poolPrices,
      });
      for (const opp of opps) { opp.trigger = 'heartbeat'; await handleOpportunity(opp); await sleep(500); }
    } catch (e) { console.error('Heartbeat error:', e.message); }
    finally { isScanning = false; }
  };

  const scheduleNext = () => setTimeout(async () => { await run(); scheduleNext(); }, SCAN_INTERVAL_MS);
  await run();
  scheduleNext();
}

main().catch(console.error);
