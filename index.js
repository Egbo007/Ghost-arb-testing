const { ethers } = require('ethers');
const fetch = require('node-fetch');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONFIG
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const RPC_URL            = process.env.RPC_URL || 'https://mainnet.base.org';
// WebSocket RPC — uses wss:// version of same endpoint
// If RPC_URL is Alchemy HTTP, derive WSS automatically. Else use public Base WSS.
const WSS_URL = process.env.WSS_URL || (() => {
  if (RPC_URL.includes('alchemy.com')) {
    return RPC_URL.replace('https://', 'wss://').replace('/v2/', '/v2/');
  }
  return 'wss://mainnet.base.org';
})();

const MIN_GAP_PERCENT    = parseFloat(process.env.MIN_GAP_PERCENT || '0.3');
const MIN_LIQUIDITY_USD  = parseFloat(process.env.MIN_LIQUIDITY_USD || '10000');
const SCAN_INTERVAL_MS   = parseInt(process.env.SCAN_INTERVAL_MS || '120000'); // Heartbeat fallback
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || '';
const WSS_RECONNECT_MS   = 15000; // 15s before reconnecting dropped WebSocket

// HTTP provider for discovery + Quoter calls (stays on HTTP)
const provider = new ethers.JsonRpcProvider(RPC_URL);

// Flash loan protocol
const FLASH_LOAN_PROTOCOL = process.env.FLASH_LOAN_PROTOCOL || 'BALANCER';
const FLASH_FEE_PCT = FLASH_LOAN_PROTOCOL === 'AAVE' ? 0.09 : 0.0;

// Alert cooldown
const lastAlertTime = new Map();
const ALERT_COOLDOWN_MS = parseInt(process.env.ALERT_COOLDOWN_MS || '600000');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LIVE PRICE REFERENCES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// V3 QUOTER — Real swap simulation on Base
//
// WHY: slot0() gives the current spot price only.
// If the trade crosses tick boundaries (price moves
// into a new liquidity range), actual output is less
// than slot0 predicts. The Quoter contract simulates
// the real swap path including all tick crossings.
//
// We use Quoter for PROFIT VERIFICATION ONLY —
// after a signal is detected by slot0 gap check,
// we call Quoter to confirm actual profitability
// before sending the alert. Slot0 is still used
// for fast event-triggered gap detection.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const QUOTER_ADDRESS = '0x3d4e44Eb1374240CE5F1B136aa68B6a741f674F7'; // Uniswap V3 Quoter v2 on Base
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];
const quoterContract = new ethers.Contract(QUOTER_ADDRESS, QUOTER_ABI, provider);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PRICE HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function sqrtPriceX96ToHumanPrice(sqrtPriceX96, isTokenAToken0, tokenADec, tokenBDec) {
  const sqrtPrice = Number(sqrtPriceX96) / 79228162514264337593543950336;
  const rawPrice = sqrtPrice * sqrtPrice;
  if (rawPrice === 0) return null;
  const decimalFactor = Math.pow(10, tokenADec - tokenBDec);
  return isTokenAToken0 ? rawPrice * decimalFactor : (1 / rawPrice) * decimalFactor;
}

function getTokenUsdPrice(symbol) {
  if (['USDC', 'USDT', 'DAI'].includes(symbol)) return 1;
  if (symbol === 'WETH') return ethUsdPrice;
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
    const sane = ratio > 0.5 && ratio < 2.0;
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
                fee: fee / 1000000, v3FeeTier: fee, minLiquidity: pair.minLiquidity });
              console.log(`    ✅ ${factory.name} ${fee/10000}%: ${addr}`);
            }
          }
        }
        if (factory.type === 'AERO') {
          const contract = new ethers.Contract(factory.address, AERO_FACTORY_ABI, provider);
          const stables = ['USDC', 'USDT', 'DAI'];
          const isStablePair = stables.includes(pair.tokenA.symbol) && stables.includes(pair.tokenB.symbol);
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
      await sleep(500);
    }
  }

  console.log(`\n✅ Discovery complete. Found ${allPools.length} pools total.\n`);
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

    const price = reserveB / reserveA;
    const liquidityUSD = computeLiquidityUSD(pool, reserveA, reserveB);

    return { ...pool, x: reserveA, y: reserveB, k: reserveA * reserveB, price, liquidityUSD };
  } catch (e) { return null; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GET V3 POOL DATA — ACTIVE LIQUIDITY
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

    if (liquidityRaw === 0n) return null;

    const Q96 = 2n ** 96n;
    const x0_raw_bn = (liquidityRaw * Q96) / sqrtPriceX96;
    const y0_raw_bn = (liquidityRaw * sqrtPriceX96) / Q96;

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
      isV3: true,
    };
  } catch (e) { return null; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// V3 QUOTER — Get real swap output for a V3 pool
//
// Called ONLY when a signal is detected (after slot0
// gap check passes). Simulates actual swap including
// tick crossings. Returns null if call fails.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function getV3Quote(pool, inputAmountHuman, buyingTokenA) {
  try {
    if (!pool.v3FeeTier) return null; // not a V3 pool, skip

    const tokenIn  = buyingTokenA ? pool.tokenB.address : pool.tokenA.address;
    const tokenOut = buyingTokenA ? pool.tokenA.address : pool.tokenB.address;
    const decimalsIn = buyingTokenA ? pool.tokenB.decimals : pool.tokenA.decimals;
    const decimalsOut = buyingTokenA ? pool.tokenA.decimals : pool.tokenB.decimals;

    const amountIn = ethers.parseUnits(inputAmountHuman.toFixed(decimalsIn), decimalsIn);

    const result = await quoterContract.quoteExactInputSingle.staticCall({
      tokenIn,
      tokenOut,
      amountIn,
      fee: pool.v3FeeTier,
      sqrtPriceLimitX96: 0n,
    });

    return parseFloat(ethers.formatUnits(result[0], decimalsOut));
  } catch (e) {
    return null; // Quoter can revert on bad input — gracefully fall back to slot0
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SIMULATE TRADE USING X*Y=K
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
// BUG FIX (v2.0): flashFee was hardcoded as 0.0009
// (Aave 0.09%) even when FLASH_LOAN_PROTOCOL=BALANCER
// (0% fee). Now correctly uses FLASH_FEE_PCT constant.
//
// V3 Quoter integration: if a V3 pool is involved,
// we attempt to get the real quoted output from the
// Quoter contract. If that fails, we fall back to
// the slot0 k-approximation with safety margin.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function findBestTradeSize(buyPool, sellPool) {
  const USD_SIZES = [1000, 5000, 10000, 25000, 50000, 100000, 200000, 500000];
  const isV3Trade = buyPool.type === 'V3' || sellPool.type === 'V3';
  const maxFraction = isV3Trade ? 0.05 : 0.10;
  const safetyFactor = isV3Trade ? 0.80 : 1.00;

  const tokenBPriceUSD = getTokenUsdPrice(buyPool.tokenB.symbol) || 1;

  let best = { size: 0, profitUSD: 0, isEstimate: isV3Trade, quoterUsed: false };

  for (const usdSize of USD_SIZES) {
    const inputTokenB = usdSize / tokenBPriceUSD;

    if (inputTokenB > buyPool.y * maxFraction) continue;

    // ── Buy leg ──────────────────────────────────────────────────
    let tokenAReceived;
    let buyQuoterUsed = false;

    if (buyPool.type === 'V3') {
      const quoted = await getV3Quote(buyPool, inputTokenB, true);
      if (quoted !== null && quoted > 0) {
        tokenAReceived = quoted;
        buyQuoterUsed = true;
      } else {
        // Fallback to k approximation
        tokenAReceived = simulateTrade(buyPool, inputTokenB, true);
      }
    } else {
      tokenAReceived = simulateTrade(buyPool, inputTokenB, true);
    }

    if (!tokenAReceived || tokenAReceived <= 0) continue;
    if (tokenAReceived > sellPool.x * maxFraction) continue;

    // ── Sell leg ─────────────────────────────────────────────────
    let tokenBReceived;
    let sellQuoterUsed = false;

    if (sellPool.type === 'V3') {
      const quoted = await getV3Quote(sellPool, tokenAReceived, false);
      if (quoted !== null && quoted > 0) {
        tokenBReceived = quoted;
        sellQuoterUsed = true;
      } else {
        tokenBReceived = simulateTrade(sellPool, tokenAReceived, false);
      }
    } else {
      tokenBReceived = simulateTrade(sellPool, tokenAReceived, false);
    }

    if (!tokenBReceived || tokenBReceived <= 0) continue;

    // ── Profit ───────────────────────────────────────────────────
    // BUG FIX: was hardcoded 0.0009 — now uses FLASH_FEE_PCT correctly
    const flashFee = inputTokenB * (FLASH_FEE_PCT / 100);
    const quoterUsed = buyQuoterUsed || sellQuoterUsed;
    // Only apply safety margin if Quoter didn't give us real numbers
    const appliedSafety = quoterUsed ? 1.0 : safetyFactor;
    const profitTokenB = (tokenBReceived - inputTokenB - flashFee) * appliedSafety;
    const profitUSD = profitTokenB * tokenBPriceUSD;

    if (profitUSD > best.profitUSD) {
      best = { size: usdSize, profitUSD, isEstimate: isV3Trade && !quoterUsed, quoterUsed };
    }
  }
  return best;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SCAN A SPECIFIC PAIR (used by WebSocket handler)
// Fetches fresh pool data for ONE pair and checks for gaps
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function scanPair(pairPools) {
  if (!pairPools || pairPools.length < 2) return null;

  const poolDataRaw = await Promise.all(
    pairPools.map(p => p.type === 'V3' ? getV3PoolData(p) : getV2PoolData(p))
  );

  const poolData = poolDataRaw.filter(p =>
    p !== null &&
    p.liquidityUSD >= (p.minLiquidity || MIN_LIQUIDITY_USD) &&
    isFinite(p.price) &&
    p.price > 0
  );

  if (poolData.length < 2) return null;

  // Update price references if WETH/USDC or cbBTC/USDC scan
  const pairName = pairPools[0].pair;
  if (pairName === 'WETH/USDC') {
    const ps = poolData.filter(p => p.price > 100).map(p => p.price).sort((a,b) => a-b);
    if (ps.length) ethUsdPrice = ps[Math.floor(ps.length / 2)];
  }
  if (pairName === 'cbBTC/USDC') {
    const ps = poolData.filter(p => p.price > 1000).map(p => p.price).sort((a,b) => a-b);
    if (ps.length) btcUsdPrice = ps[Math.floor(ps.length / 2)];
  }

  const sanePools = filterSanePrices(poolData);
  if (sanePools.length < 2) return null;

  let bestOpp = null;

  for (const buyPool of sanePools) {
    for (const sellPool of sanePools) {
      if (buyPool.address === sellPool.address) continue;
      if (buyPool.price >= sellPool.price) continue;

      const gapPct = ((sellPool.price - buyPool.price) / buyPool.price) * 100;
      if (gapPct < MIN_GAP_PERCENT || gapPct > 50) continue;

      const totalFeePct = (buyPool.fee * 100) + (sellPool.fee * 100) + FLASH_FEE_PCT;
      const netPct = gapPct - totalFeePct;
      if (netPct <= 0) continue;

      const { size: bestSize, profitUSD: bestProfitUSD, isEstimate, quoterUsed } = await findBestTradeSize(buyPool, sellPool);
      if (bestProfitUSD <= 0) continue;

      if (!bestOpp || bestProfitUSD > bestOpp.bestProfitUSD) {
        bestOpp = { pairName, buyPool, sellPool, gapPct, bestSize, bestProfitUSD, pools: sanePools, isEstimate, quoterUsed };
      }
    }
  }

  return bestOpp;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN SCAN (heartbeat — scans all pools)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function scan(allPools) {
  console.log(`\n[${new Date().toISOString()}] 💓 Heartbeat scan — ${allPools.length} pools...`);

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

  for (const p of poolDataRaw) {
    if (p && p.liquidityUSD === 0) {
      p.liquidityUSD = computeLiquidityUSD(p, p.x, p.y);
    }
  }

  const nullCount   = poolDataRaw.filter(p => p === null).length;
  const nonNull     = poolDataRaw.filter(p => p !== null);
  const withLiq     = nonNull.filter(p => p.liquidityUSD > 0);
  const liqValues   = withLiq.map(p => Math.round(p.liquidityUSD));
  const maxLiq      = liqValues.length ? Math.max(...liqValues) : 0;
  const minLiq      = liqValues.length ? Math.min(...liqValues) : 0;
  console.log(`  🔍 Pool debug: ${nullCount} null | ${nonNull.length} got data | liq $${minLiq.toLocaleString()}–$${maxLiq.toLocaleString()}`);

  const poolData = poolDataRaw.filter(p =>
    p !== null &&
    p.liquidityUSD >= (p.minLiquidity || MIN_LIQUIDITY_USD) &&
    isFinite(p.price) &&
    p.price > 0
  );

  const groups = {};
  for (const pool of poolData) {
    if (!groups[pool.pair]) groups[pool.pair] = [];
    groups[pool.pair].push(pool);
  }

  const fmtLiq = v => v >= 1e9 ? `$${(v/1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v/1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v/1e3).toFixed(1)}k` : `$${Math.round(v)}`;
  for (const [pairName, pairPools] of Object.entries(groups)) {
    const sorted = [...pairPools].sort((a, b) => a.price - b.price);
    const rawGap = sorted.length >= 2
      ? ((sorted[sorted.length-1].price - sorted[0].price) / sorted[0].price * 100).toFixed(3)
      : '0.000';
    console.log(`\n  ┌── ${pairName} │ ${sorted.length} pools │ raw gap: ${rawGap}%`);
    for (const p of sorted) {
      const dex   = p.dex.padEnd(30);
      const price = `$${p.price.toFixed(4)}`.padEnd(12);
      const fee   = `fee:${(p.fee*100).toFixed(2)}%`.padEnd(10);
      const liq   = fmtLiq(p.liquidityUSD);
      console.log(`  │  ${dex} ${price} ${fee} Liq:${liq}${p.isV3 ? ' 🟡active' : ''}`);
    }
    console.log(`  └─────────────────────────────────────────────────────`);
  }
  console.log('');

  const opportunities = [];

  for (const [pairName, pools] of Object.entries(groups)) {
    if (pools.length < 2) continue;
    const sanePools = filterSanePrices(pools);
    if (sanePools.length < 2) continue;

    let bestOpp = null;
    let mostPromising = null;

    for (const buyPool of sanePools) {
      for (const sellPool of sanePools) {
        if (buyPool.address === sellPool.address) continue;
        if (buyPool.price >= sellPool.price) continue;

        const gapPct = ((sellPool.price - buyPool.price) / buyPool.price) * 100;
        if (gapPct < MIN_GAP_PERCENT) continue;
        if (gapPct > 50) continue;

        const totalFeePct = (buyPool.fee * 100) + (sellPool.fee * 100) + FLASH_FEE_PCT;
        const netPct = gapPct - totalFeePct;

        if (!mostPromising || netPct > mostPromising.netPct) {
          mostPromising = { buyPool, sellPool, gapPct, totalFeePct, netPct };
        }

        if (netPct <= 0) continue;

        const { size: bestSize, profitUSD: bestProfitUSD, isEstimate, quoterUsed } = await findBestTradeSize(buyPool, sellPool);
        if (bestProfitUSD <= 0) continue;

        if (!bestOpp || bestProfitUSD > bestOpp.bestProfitUSD) {
          bestOpp = { pairName, buyPool, sellPool, gapPct, bestSize, bestProfitUSD, pools: sanePools, isEstimate, quoterUsed };
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
    console.log(`  ✅ ${pairName} | Gap: ${bestOpp.gapPct.toFixed(3)}% | Buy: ${bestOpp.buyPool.dex} → Sell: ${bestOpp.sellPool.dex} | $${bestOpp.bestSize.toLocaleString()} → $${bestOpp.bestProfitUSD.toFixed(2)} profit${bestOpp.isEstimate ? ' (est)' : ''}${bestOpp.quoterUsed ? ' ✅Quoter' : ''}`);
  }

  return { opportunities, scanMeta: {
    nullCount,
    belowThreshold: nonNull.length - poolData.length,
    activePools: poolData.length,
    poolsFound: poolDataRaw.length,
    poolPrices: poolData.map(p => ({
      pair: p.pair, dex: p.dex, price: parseFloat(p.price.toFixed(4)),
      tvl: Math.round(p.liquidityUSD),
      type: p.isV3 ? 'V3' : 'V2'
    }))
  }};
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TELEGRAM
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function formatAlert(opp) {
  const allPrices = opp.pools
    .sort((a, b) => a.price - b.price)
    .map(p => {
      const liqLabel = p.isV3 ? '🟡active' : '💧total';
      return `${p.dex}: $${p.price.toFixed(4)} | Liq: $${Math.round(p.liquidityUSD).toLocaleString()} ${liqLabel}`;
    })
    .join('\n');

  const profitNote = opp.quoterUsed
    ? ' <i>(V3 Quoter verified — tick crossings included)</i>'
    : opp.isEstimate
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HANDLE OPPORTUNITY — alert + log
// Shared by both WebSocket handler and heartbeat
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleOpportunity(opp) {
  const now = Date.now();
  const lastAlert = lastAlertTime.get(opp.pairName) || 0;
  if (now - lastAlert < ALERT_COOLDOWN_MS) {
    const minsLeft = Math.ceil((ALERT_COOLDOWN_MS - (now - lastAlert)) / 60000);
    console.log(`  ⏳ ${opp.pairName}: Signal found but on cooldown (${minsLeft}min left)`);
    return;
  }
  lastAlertTime.set(opp.pairName, now);
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
    profit: opp.bestProfitUSD.toFixed(2),
    isEstimate: opp.isEstimate,
    quoterUsed: opp.quoterUsed || false,
    flashProtocol: FLASH_LOAN_PROTOCOL,
    ethPrice: ethUsdPrice,
    btcPrice: btcUsdPrice,
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WEBSOCKET SCANNING
//
// How it works:
//   1. Create a WebSocketProvider using wss://mainnet.base.org
//   2. For every discovered pool, subscribe to its Swap event
//   3. When a Swap fires on pool X, re-fetch prices for that
//      pair (all pools of same pair), check for gaps
//   4. If profitable → send alert via handleOpportunity()
//   5. If connection drops → log to Sheets + Telegram,
//      wait 15s, reconnect and re-subscribe to all pools
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let wssProvider = null;
let wssListeners = []; // track active listeners for cleanup on reconnect
let wssDisconnectCount = 0;

async function startWebSocket(allPools) {
  // Group pools by pair name for targeted rescans
  const pairGroups = {};
  for (const pool of allPools) {
    if (!pairGroups[pool.pair]) pairGroups[pool.pair] = [];
    pairGroups[pool.pair].push(pool);
  }

  // Track which pools are being actively processed to avoid duplicate triggers
  const processing = new Set();

  const connect = async () => {
    console.log(`\n⚡ Connecting WebSocket to ${WSS_URL}...`);
    try {
      wssProvider = new ethers.WebSocketProvider(WSS_URL);

      // Wait for connection
      await wssProvider.ready;
      console.log('⚡ WebSocket connected. Subscribing to Swap events...');

      wssListeners = [];

      for (const pool of allPools) {
        // Choose correct Swap event ABI based on pool type
        const abi = pool.type === 'V3' ? V3_POOL_ABI : V2_POOL_SWAP_ABI;
        const contract = new ethers.Contract(pool.address, abi, wssProvider);

        const handler = async (...args) => {
          const poolKey = pool.address;
          if (processing.has(poolKey)) return; // already checking this pool
          processing.add(poolKey);

          try {
            console.log(`  ⚡ Swap on ${pool.dex} (${pool.pair}) — scanning pair...`);
            const opp = await scanPair(pairGroups[pool.pair]);
            if (opp) {
              opp.trigger = `WebSocket: ${pool.dex}`;
              await handleOpportunity(opp);
            }
          } catch (e) {
            console.error(`  WSS scan error: ${e.message}`);
          } finally {
            processing.delete(poolKey);
          }
        };

        contract.on('Swap', handler);
        wssListeners.push({ contract, handler });
      }

      console.log(`⚡ Subscribed to Swap events on ${allPools.length} pools.\n`);

      // Handle WebSocket disconnect
      wssProvider.websocket.on('close', async () => {
        wssDisconnectCount++;
        const ts = new Date().toISOString();
        console.log(`\n🔌 WebSocket disconnected at ${ts}. Reconnecting in ${WSS_RECONNECT_MS/1000}s...`);

        // Telegram alert on disconnect
        sendTelegram(`🔌 <b>WebSocket Disconnected</b>
Reconnecting in ${WSS_RECONNECT_MS/1000}s...
Disconnect #${wssDisconnectCount}
Time: ${ts}`);

        // Log disconnect to Sheets for reliability tracking
        logToSheets({
          timestamp: ts,
          type: 'wss_disconnect',
          disconnectCount: wssDisconnectCount,
          message: 'WebSocket connection dropped',
        });

        // Clean up old listeners
        for (const { contract, handler } of wssListeners) {
          try { contract.off('Swap', handler); } catch (_) {}
        }
        wssListeners = [];

        await sleep(WSS_RECONNECT_MS);
        connect(); // reconnect
      });

      wssProvider.websocket.on('error', (err) => {
        console.error(`  WSS error: ${err.message}`);
      });

    } catch (e) {
      console.error(`⚡ WebSocket connect failed: ${e.message}. Retrying in ${WSS_RECONNECT_MS/1000}s...`);
      await sleep(WSS_RECONNECT_MS);
      connect();
    }
  };

  connect();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Ghost Arb Monitor v2.0                 ║');
  console.log('║   WebSocket + V3 Quoter + Fee Fix        ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`HTTP RPC: ${RPC_URL}`);
  console.log(`WSS RPC:  ${WSS_URL}`);
  console.log(`Flash loan: ${FLASH_LOAN_PROTOCOL} (${FLASH_FEE_PCT}% fee)`);
  console.log(`Min gap: ${MIN_GAP_PERCENT}% | Min liquidity: $${MIN_LIQUIDITY_USD.toLocaleString()}`);
  console.log(`Heartbeat: every ${SCAN_INTERVAL_MS / 1000}s | WSS reconnect: ${WSS_RECONNECT_MS/1000}s`);
  console.log(`Watching ${WATCH_PAIRS.length} pairs across ${FACTORIES.length} DEXes`);

  if (SHEETS_WEBHOOK_URL) {
    console.log('📊 Testing Google Sheets connection...');
    await logToSheets({ timestamp: new Date().toISOString(), type: 'startup', message: 'Ghost Arb Monitor v2.0 connected' });
  } else {
    console.log('📊 Google Sheets: not configured (set SHEETS_WEBHOOK_URL in Railway)');
  }

  const allPools = await discoverAllPools();
  if (allPools.length === 0) { console.error('❌ No pools found. Check RPC.'); process.exit(1); }

  await sendTelegram(`🤖 <b>Ghost Arb Monitor v2.0 LIVE</b>

⚡ WebSocket event-driven scanning active
🎯 V3 Quoter — real swap simulation for V3 pools
🐛 Balancer flash fee bug fixed (was using Aave rate)
💓 Heartbeat fallback every ${SCAN_INTERVAL_MS/1000}s
🔌 WSS reconnect: 15s | Disconnect alerts: ON
📊 Disconnect frequency logged to Google Sheets

✅ Found <b>${allPools.length} pools</b>
Gap: ${MIN_GAP_PERCENT}% | Flash: ${FLASH_LOAN_PROTOCOL} (${FLASH_FEE_PCT}% fee)
WSS: ${WSS_URL}`);

  // Start WebSocket (event-driven — fires on every swap)
  await startWebSocket(allPools);

  // Heartbeat fallback loop — runs full scan every SCAN_INTERVAL_MS
  // Catches any gaps the WebSocket might miss between events
  let isScanning = false;
  const run = async () => {
    if (isScanning) {
      console.log('  ⏭️  Previous heartbeat scan still running — skipping.');
      return;
    }
    isScanning = true;
    try {
      const { opportunities: opps, scanMeta } = await scan(allPools);

      logToSheets({
        timestamp: new Date().toISOString(),
        type: 'heartbeat',
        ethPrice: ethUsdPrice,
        btcPrice: btcUsdPrice,
        poolsFound: scanMeta.poolsFound,
        rpcFailed: scanMeta.nullCount,
        belowThreshold: scanMeta.belowThreshold,
        activePools: scanMeta.activePools,
        pools: scanMeta.poolPrices,
        flashProtocol: FLASH_LOAN_PROTOCOL,
        bestPair: opps.length ? opps[0].pairName : null,
        bestGap: opps.length ? opps[0].gapPct.toFixed(3) : null,
        decision: opps.length ? 'signal' : 'no opportunity',
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
