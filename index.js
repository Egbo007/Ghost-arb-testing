const { ethers } = require('ethers');
const fetch = require('node-fetch');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONFIG
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const RPC_URL            = process.env.RPC_URL || 'https://mainnet.base.org';
const MIN_GAP_PERCENT    = parseFloat(process.env.MIN_GAP_PERCENT || '1.0');
const MIN_LIQUIDITY_USD  = parseFloat(process.env.MIN_LIQUIDITY_USD || '50000');
const SCAN_INTERVAL_MS   = parseInt(process.env.SCAN_INTERVAL_MS || '60000');

const provider = new ethers.JsonRpcProvider(RPC_URL);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOKEN ADDRESSES ON BASE (verified)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const TOKENS = {
  WETH:  { address: '0x4200000000000000000000000000000000000006', decimals: 18, symbol: 'WETH'  },
  USDC:  { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6,  symbol: 'USDC'  },
  cbETH: { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18, symbol: 'cbETH' },
  WBTC:  { address: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', decimals: 8,  symbol: 'WBTC'  },
  cbBTC: { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8,  symbol: 'cbBTC' },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FACTORY CONTRACTS ON BASE
// These are the master contracts that created
// every pool on each DEX. We ask them:
// "give me the pool address for WETH/USDC"
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const FACTORIES = [
  {
    name: 'Uniswap V2',
    address: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
    type: 'V2',
  },
  {
    name: 'Uniswap V3',
    address: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    type: 'V3',
    feeTiers: [100, 500, 3000, 10000], // 0.01%, 0.05%, 0.3%, 1%
  },
  {
    name: 'SushiSwap V2',
    address: '0x71524B4f93c58fcbF659783284E38825f0622859',
    type: 'V2',
  },
  {
    name: 'SushiSwap V3',
    address: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
    type: 'V3',
    feeTiers: [100, 500, 3000, 10000],
  },
  {
    name: 'Aerodrome V2',
    address: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
    type: 'AERO',
  },
  {
    name: 'PancakeSwap V2',
    address: '0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E',
    type: 'V2',
  },
  {
    name: 'PancakeSwap V3',
    address: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    type: 'V3',
    feeTiers: [100, 500, 2500, 10000],
  },
  {
    name: 'BaseSwap V2',
    address: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB',
    type: 'V2',
  },
  {
    name: 'AlienBase V2',
    address: '0x3E84D913803b02A4a7f027165E8cA42C14C0FdE7',
    type: 'V2',
  },
  {
    name: 'SwapBased V2',
    address: '0x04C9f118d21e8B767D2e50C946f0cC9F6C367300',
    type: 'V2',
  },
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PAIRS TO WATCH
// Bot will find ALL pools for each pair
// across ALL factories automatically
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const WATCH_PAIRS = [
  { name: 'WETH/USDC',  tokenA: TOKENS.WETH,  tokenB: TOKENS.USDC  },
  { name: 'cbETH/WETH', tokenA: TOKENS.cbETH, tokenB: TOKENS.WETH  },
  { name: 'WBTC/WETH',  tokenA: TOKENS.WBTC,  tokenB: TOKENS.WETH  },
  { name: 'cbBTC/WETH', tokenA: TOKENS.cbBTC, tokenB: TOKENS.WETH  },
  { name: 'cbBTC/WBTC', tokenA: TOKENS.cbBTC, tokenB: TOKENS.WBTC  },
  { name: 'cbBTC/USDC', tokenA: TOKENS.cbBTC, tokenB: TOKENS.USDC  },
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ABIs — just the functions we need
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const V2_FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
];

const V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
];

const AERO_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, bool stable) view returns (address pool)',
];

const V2_POOL_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];

// V3 uses slot0 + liquidity for price, simpler than full tick math
const V3_POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DISCOVER ALL POOLS FROM FACTORIES
// This runs once at startup. Queries every
// factory for every pair. Builds a full list
// of real pool addresses automatically.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function discoverAllPools() {
  console.log('\n🔍 Discovering all pools from factory contracts...');
  const allPools = [];
  const ZERO = '0x0000000000000000000000000000000000000000';

  for (const pair of WATCH_PAIRS) {
    console.log(`\n  Pair: ${pair.name}`);

    for (const factory of FACTORIES) {
      try {
        // ── V2 style factories ──
        if (factory.type === 'V2') {
          const contract = new ethers.Contract(factory.address, V2_FACTORY_ABI, provider);
          const poolAddr = await contract.getPair(pair.tokenA.address, pair.tokenB.address);

          if (poolAddr && poolAddr !== ZERO) {
            allPools.push({
              pair:    pair.name,
              dex:     factory.name,
              type:    'V2',
              address: poolAddr,
              tokenA:  pair.tokenA,
              tokenB:  pair.tokenB,
              fee:     0.003,
            });
            console.log(`    ✅ ${factory.name}: ${poolAddr}`);
          }
        }

        // ── V3 style factories (multiple fee tiers) ──
        if (factory.type === 'V3') {
          const contract = new ethers.Contract(factory.address, V3_FACTORY_ABI, provider);

          for (const feeTier of factory.feeTiers) {
            const poolAddr = await contract.getPool(pair.tokenA.address, pair.tokenB.address, feeTier);

            if (poolAddr && poolAddr !== ZERO) {
              allPools.push({
                pair:    pair.name,
                dex:     `${factory.name} ${feeTier/10000}%`,
                type:    'V3',
                address: poolAddr,
                tokenA:  pair.tokenA,
                tokenB:  pair.tokenB,
                fee:     feeTier / 1000000,
              });
              console.log(`    ✅ ${factory.name} ${feeTier/10000}%: ${poolAddr}`);
            }
          }
        }

        // ── Aerodrome style (stable vs volatile) ──
        if (factory.type === 'AERO') {
          const contract = new ethers.Contract(factory.address, AERO_FACTORY_ABI, provider);

          // Check both volatile (false) and stable (true) versions
          for (const stable of [false, true]) {
            const poolAddr = await contract.getPool(pair.tokenA.address, pair.tokenB.address, stable);

            if (poolAddr && poolAddr !== ZERO) {
              allPools.push({
                pair:    pair.name,
                dex:     `Aerodrome ${stable ? 'sAMM' : 'vAMM'}`,
                type:    'V2', // Aerodrome uses V2 math (x*y=k)
                address: poolAddr,
                tokenA:  pair.tokenA,
                tokenB:  pair.tokenB,
                fee:     stable ? 0.0001 : 0.003,
              });
              console.log(`    ✅ Aerodrome ${stable ? 'sAMM' : 'vAMM'}: ${poolAddr}`);
            }
          }
        }

      } catch (e) {
        // Factory doesn't support this pair or network error — skip silently
      }

      // Small delay to avoid hammering the RPC
      await sleep(200);
    }
  }

  console.log(`\n✅ Discovery complete. Found ${allPools.length} pools total.\n`);
  return allPools;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GET PRICE FROM V2 POOL (getReserves)
// Simple x*y=k math. Returns price and
// real x, y, k values.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function getV2PoolData(pool) {
  try {
    const contract = new ethers.Contract(pool.address, V2_POOL_ABI, provider);

    const [reserves, token0Addr] = await Promise.all([
      contract.getReserves(),
      contract.token0(),
    ]);

    // token0 is whichever address is numerically smaller
    // We need to know which of our tokens is token0
    const isTokenAisToken0 = token0Addr.toLowerCase() === pool.tokenA.address.toLowerCase();

    const rawReserve0 = reserves[0];
    const rawReserve1 = reserves[1];

    // Assign correctly based on token order
    const reserveA = isTokenAisToken0
      ? parseFloat(ethers.formatUnits(rawReserve0, pool.tokenA.decimals))
      : parseFloat(ethers.formatUnits(rawReserve1, pool.tokenA.decimals));

    const reserveB = isTokenAisToken0
      ? parseFloat(ethers.formatUnits(rawReserve1, pool.tokenB.decimals))
      : parseFloat(ethers.formatUnits(rawReserve0, pool.tokenB.decimals));

    if (reserveA === 0 || reserveB === 0) return null;

    const k = reserveA * reserveB;

    // Price of tokenA in terms of tokenB
    // e.g. for WETH/USDC: price = USDC per WETH
    const price = reserveB / reserveA;

    // Liquidity in USD — estimate using USDC side if available
    // otherwise use both sides * price
    const liquidityUSD = pool.tokenB.symbol === 'USDC' || pool.tokenB.symbol === 'USDT'
      ? reserveB * 2
      : reserveA * 2 * price;

    return {
      ...pool,
      x:            reserveA,
      y:            reserveB,
      k:            k,
      price:        price,
      liquidityUSD: liquidityUSD,
    };
  } catch (e) {
    return null;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GET PRICE FROM V3 POOL (slot0)
// V3 stores price as sqrtPriceX96.
// We convert it to a human-readable price.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function getV3PoolData(pool) {
  try {
    const contract = new ethers.Contract(pool.address, V3_POOL_ABI, provider);

    const [slot0Data, token0Addr] = await Promise.all([
      contract.slot0(),
      contract.token0(),
    ]);

    const sqrtPriceX96 = slot0Data[0];

    if (sqrtPriceX96 === 0n) return null;

    // Convert sqrtPriceX96 to actual price
    // price = (sqrtPriceX96 / 2^96)^2
    const Q96 = 2n ** 96n;
    const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
    const rawPrice = sqrtPrice * sqrtPrice;

    // Adjust for decimals difference between token0 and token1
    const isTokenAisToken0 = token0Addr.toLowerCase() === pool.tokenA.address.toLowerCase();

    const decimalAdjustment = 10 ** (pool.tokenA.decimals - pool.tokenB.decimals);

    // rawPrice gives token1/token0 in raw units
    // We want tokenA price in tokenB
    let price;
    if (isTokenAisToken0) {
      // price = rawPrice * decimalAdjustment gives tokenB per tokenA
      price = rawPrice * (10 ** pool.tokenB.decimals) / (10 ** pool.tokenA.decimals);
    } else {
      // token0 is tokenB, token1 is tokenA
      price = (1 / rawPrice) * (10 ** pool.tokenA.decimals) / (10 ** pool.tokenB.decimals);
    }

    // For V3 we don't have direct reserves
    // Use token balances as approximation for liquidity
    const tokenAContract = new ethers.Contract(pool.tokenA.address, ERC20_ABI, provider);
    const tokenBContract = new ethers.Contract(pool.tokenB.address, ERC20_ABI, provider);

    const [balA, balB] = await Promise.all([
      tokenAContract.balanceOf(pool.address),
      tokenBContract.balanceOf(pool.address),
    ]);

    const reserveA = parseFloat(ethers.formatUnits(balA, pool.tokenA.decimals));
    const reserveB = parseFloat(ethers.formatUnits(balB, pool.tokenB.decimals));

    const liquidityUSD = pool.tokenB.symbol === 'USDC' || pool.tokenB.symbol === 'USDT'
      ? reserveB * 2
      : reserveA * price * 2;

    return {
      ...pool,
      x:            reserveA,
      y:            reserveB,
      k:            reserveA * reserveB, // approximate for V3
      price:        price,
      liquidityUSD: liquidityUSD,
    };
  } catch (e) {
    return null;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CALCULATE SLIPPAGE-ADJUSTED PROFIT
// Uses x*y=k to simulate the actual trade
// Returns exact dollar profit after fees
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function simulateV2Trade(pool, usdcIn, buying) {
  // buying = spending USDC to get tokenA
  // selling = spending tokenA to get USDC
  const x = pool.x; // tokenA reserves
  const y = pool.y; // tokenB reserves
  const k = pool.k;
  const feeMultiplier = 1 - pool.fee;

  if (buying) {
    // Spend usdcIn (tokenB) to get tokenA
    const inputAfterFee = usdcIn * feeMultiplier;
    const newY = y + inputAfterFee;
    const newX = k / newY;
    return x - newX; // tokenA received
  } else {
    // Spend tokenA amount to get USDC (tokenB)
    const inputAfterFee = usdcIn * feeMultiplier;
    const newX = x + inputAfterFee;
    const newY = k / newX;
    return y - newY; // tokenB received
  }
}

function findBestTradeSize(buyPool, sellPool) {
  // Try different sizes, find where profit is maximum
  const sizes = [1000, 5000, 10000, 25000, 50000, 100000, 200000, 500000];
  let best = { size: 0, profit: 0 };

  for (const usdcIn of sizes) {
    // Skip if buy pool doesn't have enough liquidity
    if (usdcIn > buyPool.liquidityUSD * 0.15) continue;
    // Skip if sell pool doesn't have enough liquidity
    if (usdcIn > sellPool.liquidityUSD * 0.15) continue;

    // Step 1: How much tokenA do we get from buyPool?
    const tokenAReceived = simulateV2Trade(buyPool, usdcIn, true);
    if (tokenAReceived <= 0) continue;

    // Step 2: How much USDC do we get from selling tokenA into sellPool?
    const usdcReceived = simulateV2Trade(sellPool, tokenAReceived, false);
    if (usdcReceived <= 0) continue;

    // Step 3: Subtract Aave flash loan fee (0.09%)
    const flashLoanFee = usdcIn * 0.0009;

    // Step 4: Net profit
    const profit = usdcReceived - usdcIn - flashLoanFee;

    if (profit > best.profit) {
      best = { size: usdcIn, profit };
    }
  }

  return best;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN SCAN — runs every 60 seconds
// Fetches all pool data, finds gaps,
// calculates real profit, sends alerts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function scan(allPools) {
  console.log(`\n[${new Date().toISOString()}] Scanning ${allPools.length} pools...`);

  // Fetch all pool data in parallel
  const poolDataPromises = allPools.map(pool =>
    pool.type === 'V3' ? getV3PoolData(pool) : getV2PoolData(pool)
  );

  const poolDataRaw = await Promise.all(poolDataPromises);
  const poolData = poolDataRaw.filter(p => p !== null && p.liquidityUSD >= MIN_LIQUIDITY_USD);

  console.log(`  Active pools (above $${MIN_LIQUIDITY_USD.toLocaleString()} liquidity): ${poolData.length}`);

  // Group by pair name
  const groups = {};
  for (const pool of poolData) {
    if (!groups[pool.pair]) groups[pool.pair] = [];
    groups[pool.pair].push(pool);
  }

  const opportunities = [];

  for (const [pairName, pools] of Object.entries(groups)) {
    if (pools.length < 2) continue;

    // Sort cheapest to most expensive
    pools.sort((a, b) => a.price - b.price);

    const buyPool  = pools[0];
    const sellPool = pools[pools.length - 1];

    const gapPct = ((sellPool.price - buyPool.price) / buyPool.price) * 100;

    if (gapPct < MIN_GAP_PERCENT) continue;

    // Only proceed if V2-style pools (we can simulate accurately)
    // V3 simulation is approximate, flag it
    const canSimulate = buyPool.type !== 'V3' && sellPool.type !== 'V3';

    let bestSize = 0;
    let bestProfit = 0;

    if (canSimulate) {
      const result = findBestTradeSize(buyPool, sellPool);
      bestSize   = result.size;
      bestProfit = result.profit;
    } else {
      // Rough estimate for V3 pairs
      bestSize   = 50000;
      bestProfit = (gapPct / 100 * 50000) - (50000 * 0.006) - (50000 * 0.0009);
    }

    if (bestProfit <= 0) {
      console.log(`  ❌ ${pairName}: Gap ${gapPct.toFixed(3)}% but slippage kills profit`);
      continue;
    }

    opportunities.push({ pairName, buyPool, sellPool, gapPct, bestSize, bestProfit, pools, canSimulate });
    console.log(`  ✅ ${pairName} | Gap: ${gapPct.toFixed(3)}% | Size: $${bestSize.toLocaleString()} | Profit: $${bestProfit.toFixed(2)}`);
  }

  return opportunities;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TELEGRAM ALERT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function formatAlert(opp) {
  const allPrices = opp.pools
    .map(p => `${p.dex}: $${p.price.toFixed(4)} | Liq: $${Math.round(p.liquidityUSD).toLocaleString()}`)
    .join('\n');

  const simNote = opp.canSimulate ? '' : '\n⚠️ V3 pool — profit is estimated';

  return `🟢 <b>ARB SIGNAL — ${opp.pairName}</b>

📐 Gap: <b>${opp.gapPct.toFixed(3)}%</b>

🔻 <b>BUY on</b> ${opp.buyPool.dex}
   Price: $${opp.buyPool.price.toFixed(6)}
   x: ${opp.buyPool.x.toFixed(4)} ${opp.buyPool.tokenA.symbol}
   y: ${opp.buyPool.y.toFixed(2)} ${opp.buyPool.tokenB.symbol}
   k: ${opp.buyPool.k.toFixed(0)}
   Liquidity: $${Math.round(opp.buyPool.liquidityUSD).toLocaleString()}

🔺 <b>SELL on</b> ${opp.sellPool.dex}
   Price: $${opp.sellPool.price.toFixed(6)}
   Liquidity: $${Math.round(opp.sellPool.liquidityUSD).toLocaleString()}

💰 <b>Optimal trade size:</b> $${opp.bestSize.toLocaleString()}
💵 <b>Estimated profit:</b> $${opp.bestProfit.toFixed(2)}
   (after DEX fees + Aave 0.09% + slippage)${simNote}

🏪 <b>All pools:</b>
${allPrices}

⏰ ${new Date().toUTCString()}`;
}

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('Telegram error:', e.message); }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   Ghost Arb Monitor v4.0             ║');
  console.log('║   Auto Pool Discovery Edition        ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Min gap: ${MIN_GAP_PERCENT}% | Min liquidity: $${MIN_LIQUIDITY_USD.toLocaleString()}`);

  // Step 1: Discover ALL pools from all factories automatically
  const allPools = await discoverAllPools();

  if (allPools.length === 0) {
    console.error('❌ No pools found. Check RPC connection.');
    process.exit(1);
  }

  await sendTelegram(`🤖 <b>Ghost Arb Monitor v4.0 LIVE</b>

✅ Auto pool discovery complete
✅ Found <b>${allPools.length} pools</b> across ${FACTORIES.length} DEXes
✅ Watching ${WATCH_PAIRS.length} pairs
✅ Real x,y,k from blockchain
✅ Slippage-adjusted profit calculation

Scanning every ${SCAN_INTERVAL_MS / 1000}s
Min gap: ${MIN_GAP_PERCENT}% | Min liquidity: $${MIN_LIQUIDITY_USD.toLocaleString()}`);

  // Step 2: Scan loop
  const run = async () => {
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
    } catch (e) {
      console.error('Scan error:', e.message);
    }
  };

  await run();
  setInterval(run, SCAN_INTERVAL_MS);
}

main().catch(console.error);
