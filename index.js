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
// PAIRS TO WATCH
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
];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// V3 PRICE FIX — correct decimal adjustment
//
// sqrtPriceX96 = sqrt(token1_raw / token0_raw) * 2^96
// rawPrice = token1_raw / token0_raw
//
// To get human price of tokenA in tokenB:
// If tokenA is token0: price = rawPrice * 10^(tokenA_dec - tokenB_dec)
// If tokenA is token1: price = (1/rawPrice) * 10^(tokenA_dec - tokenB_dec)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function sqrtPriceX96ToHumanPrice(sqrtPriceX96, isTokenAToken0, tokenADec, tokenBDec) {
  // Convert BigInt sqrtPriceX96 to float safely
  // Q96 = 2^96 = 79228162514264337593543950336
  const sqrtPrice = Number(sqrtPriceX96) / 79228162514264337593543950336;
  // rawPrice = token1_raw / token0_raw (in smallest units)
  const rawPrice = sqrtPrice * sqrtPrice;

  if (rawPrice === 0) return null;

  // Adjust for human decimals — this was the bug before, now fixed
  const decimalFactor = Math.pow(10, tokenADec - tokenBDec);

  if (isTokenAToken0) {
    // tokenA=token0, tokenB=token1
    // rawPrice = tokenB_raw/tokenA_raw
    // humanPrice = rawPrice * 10^(tokenA_dec - tokenB_dec)
    return rawPrice * decimalFactor;
  } else {
    // tokenA=token1, tokenB=token0
    // rawPrice = tokenA_raw/tokenB_raw
    // humanPrice = (1/rawPrice) * 10^(tokenA_dec - tokenB_dec)
    return (1 / rawPrice) * decimalFactor;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SANITY CHECK — filter out clearly wrong prices
// If a pool's price is more than 20x away from
// median of other pools, it's a bad price
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function filterSanePrices(pools) {
  if (pools.length <= 2) return pools;

  const prices = pools.map(p => p.price).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];

  return pools.filter(p => {
    const ratio = p.price / median;
    const sane = ratio > 0.05 && ratio < 20; // within 20x of median
    if (!sane) {
      console.log(`  ⚠️  Filtered bad price: ${p.dex} @ ${p.price.toFixed(6)} (median: ${median.toFixed(6)})`);
    }
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
            allPools.push({ pair: pair.name, dex: factory.name, type: 'V2', address: addr, tokenA: pair.tokenA, tokenB: pair.tokenB, fee: 0.003 });
            console.log(`    ✅ ${factory.name}: ${addr}`);
          }
        }
        if (factory.type === 'V3') {
          const contract = new ethers.Contract(factory.address, V3_FACTORY_ABI, provider);
          for (const fee of factory.feeTiers) {
            const addr = await contract.getPool(pair.tokenA.address, pair.tokenB.address, fee);
            if (addr && addr !== ZERO) {
              allPools.push({ pair: pair.name, dex: `${factory.name} ${fee/10000}%`, type: 'V3', address: addr, tokenA: pair.tokenA, tokenB: pair.tokenB, fee: fee / 1000000 });
              console.log(`    ✅ ${factory.name} ${fee/10000}%: ${addr}`);
            }
          }
        }
        if (factory.type === 'AERO') {
          const contract = new ethers.Contract(factory.address, AERO_FACTORY_ABI, provider);
          for (const stable of [false, true]) {
            const addr = await contract.getPool(pair.tokenA.address, pair.tokenB.address, stable);
            if (addr && addr !== ZERO) {
              allPools.push({ pair: pair.name, dex: `Aerodrome ${stable ? 'sAMM' : 'vAMM'}`, type: 'V2', address: addr, tokenA: pair.tokenA, tokenB: pair.tokenB, fee: stable ? 0.0001 : 0.003 });
              console.log(`    ✅ Aerodrome ${stable ? 'sAMM' : 'vAMM'}: ${addr}`);
            }
          }
        }
      } catch (e) { /* pool doesn't exist on this dex — skip */ }
      await sleep(150);
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
    const k = reserveA * reserveB;

    // Liquidity in USD
    const liquidityUSD = (pool.tokenB.symbol === 'USDC' || pool.tokenB.symbol === 'USDT')
      ? reserveB * 2
      : (pool.tokenA.symbol === 'USDC' || pool.tokenA.symbol === 'USDT')
        ? reserveA * 2
        : reserveA * price * 2;

    return { ...pool, x: reserveA, y: reserveB, k, price, liquidityUSD };
  } catch (e) { return null; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GET V3 POOL DATA — fixed price calculation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function getV3PoolData(pool) {
  try {
    const contract = new ethers.Contract(pool.address, V3_POOL_ABI, provider);
    const [slot0Data, token0Addr] = await Promise.all([contract.slot0(), contract.token0()]);

    const sqrtPriceX96 = slot0Data[0];
    if (sqrtPriceX96 === 0n) return null;

    const isTokenAToken0 = token0Addr.toLowerCase() === pool.tokenA.address.toLowerCase();

    // FIXED: correct decimal adjustment
    const price = sqrtPriceX96ToHumanPrice(
      sqrtPriceX96,
      isTokenAToken0,
      pool.tokenA.decimals,
      pool.tokenB.decimals
    );

    if (!price || price <= 0 || !isFinite(price)) return null;

    // Get token balances for liquidity estimate
    const tokenAContract = new ethers.Contract(pool.tokenA.address, ERC20_ABI, provider);
    const tokenBContract = new ethers.Contract(pool.tokenB.address, ERC20_ABI, provider);
    const [balA, balB] = await Promise.all([
      tokenAContract.balanceOf(pool.address),
      tokenBContract.balanceOf(pool.address),
    ]);

    const reserveA = parseFloat(ethers.formatUnits(balA, pool.tokenA.decimals));
    const reserveB = parseFloat(ethers.formatUnits(balB, pool.tokenB.decimals));

    const liquidityUSD = (pool.tokenB.symbol === 'USDC' || pool.tokenB.symbol === 'USDT')
      ? reserveB * 2
      : (pool.tokenA.symbol === 'USDC' || pool.tokenA.symbol === 'USDT')
        ? reserveA * 2
        : reserveA * price * 2;

    return { ...pool, x: reserveA, y: reserveB, k: reserveA * reserveB, price, liquidityUSD };
  } catch (e) { return null; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SIMULATE TRADE USING X*Y=K
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

function findBestTradeSize(buyPool, sellPool) {
  const sizes = [1000, 5000, 10000, 25000, 50000, 100000, 200000, 500000];
  let best = { size: 0, profit: 0 };

  // Only simulate V2 pools accurately — V3 approximation less reliable
  if (buyPool.type === 'V3' || sellPool.type === 'V3') {
    // Rough estimate for V3
    const usdcIn = 50000;
    const gapPct = (sellPool.price - buyPool.price) / buyPool.price;
    const roughProfit = usdcIn * gapPct - usdcIn * 0.006 - usdcIn * 0.0009;
    return { size: usdcIn, profit: Math.max(0, roughProfit), isEstimate: true };
  }

  for (const usdcIn of sizes) {
    if (usdcIn > buyPool.liquidityUSD * 0.1) continue;
    if (usdcIn > sellPool.liquidityUSD * 0.1) continue;

    // Buy tokenA using tokenB (e.g. buy WETH using USDC)
    const tokenAReceived = simulateTrade(buyPool, usdcIn, true);
    if (tokenAReceived <= 0) continue;

    // Sell tokenA for tokenB
    const tokenBReceived = simulateTrade(sellPool, tokenAReceived, false);
    if (tokenBReceived <= 0) continue;

    const flashFee = usdcIn * 0.0009;
    const profit = tokenBReceived - usdcIn - flashFee;

    if (profit > best.profit) {
      best = { size: usdcIn, profit, isEstimate: false };
    }
  }
  return best;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN SCAN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function scan(allPools) {
  console.log(`\n[${new Date().toISOString()}] Scanning ${allPools.length} pools...`);

  const poolDataRaw = await Promise.all(
    allPools.map(p => p.type === 'V3' ? getV3PoolData(p) : getV2PoolData(p))
  );

  const poolData = poolDataRaw.filter(p =>
    p !== null &&
    p.liquidityUSD >= MIN_LIQUIDITY_USD &&
    isFinite(p.price) &&
    p.price > 0
  );

  console.log(`  Active pools (≥$${MIN_LIQUIDITY_USD.toLocaleString()} liquidity): ${poolData.length}`);

  // Group by pair
  const groups = {};
  for (const pool of poolData) {
    if (!groups[pool.pair]) groups[pool.pair] = [];
    groups[pool.pair].push(pool);
  }

  const opportunities = [];

  for (const [pairName, pools] of Object.entries(groups)) {
    if (pools.length < 2) continue;

    // FILTER OUT BAD PRICES before comparing
    const sanePools = filterSanePrices(pools);
    if (sanePools.length < 2) continue;

    sanePools.sort((a, b) => a.price - b.price);
    const buyPool  = sanePools[0];
    const sellPool = sanePools[sanePools.length - 1];

    const gapPct = ((sellPool.price - buyPool.price) / buyPool.price) * 100;
    if (gapPct < MIN_GAP_PERCENT) continue;

    // Extra sanity: reject gaps above 50% — almost certainly a bad price
    if (gapPct > 50) {
      console.log(`  ⚠️  ${pairName}: Gap ${gapPct.toFixed(2)}% — too large, likely bad price data, skipping`);
      continue;
    }

    const { size: bestSize, profit: bestProfit, isEstimate } = findBestTradeSize(buyPool, sellPool);

    if (bestProfit <= 0) {
      console.log(`  ❌ ${pairName}: Gap ${gapPct.toFixed(3)}% but slippage kills profit`);
      continue;
    }

    opportunities.push({ pairName, buyPool, sellPool, gapPct, bestSize, bestProfit, pools: sanePools, isEstimate });
    console.log(`  ✅ ${pairName} | Gap: ${gapPct.toFixed(3)}% | Size: $${bestSize.toLocaleString()} | Profit: $${bestProfit.toFixed(2)}${isEstimate ? ' (est)' : ''}`);
  }

  return opportunities;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TELEGRAM
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function formatAlert(opp) {
  const allPrices = opp.pools
    .map(p => `${p.dex}: $${p.price.toFixed(4)} | Liq: $${Math.round(p.liquidityUSD).toLocaleString()}`)
    .join('\n');

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

💰 <b>Optimal size:</b> $${opp.bestSize.toLocaleString()}
💵 <b>Est. profit:</b> $${opp.bestProfit.toFixed(2)}${opp.isEstimate ? ' (V3 estimate)' : ''}
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
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('Telegram error:', e.message); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   Ghost Arb Monitor v4.1             ║');
  console.log('║   Fixed Price Calculation            ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Min gap: ${MIN_GAP_PERCENT}% | Min liquidity: $${MIN_LIQUIDITY_USD.toLocaleString()}`);

  const allPools = await discoverAllPools();
  if (allPools.length === 0) { console.error('❌ No pools found. Check RPC.'); process.exit(1); }

  await sendTelegram(`🤖 <b>Ghost Arb Monitor v4.1 LIVE</b>

✅ Fixed V3 price calculation
✅ Sanity filter: gaps above 50% auto-rejected
✅ Found <b>${allPools.length} pools</b> across ${FACTORIES.length} DEXes
✅ Real x,y,k from blockchain
✅ Slippage-adjusted profit

Scanning every ${SCAN_INTERVAL_MS / 1000}s`);

  const run = async () => {
    try {
      const opps = await scan(allPools);
      if (opps.length === 0) { console.log('  No profitable opportunities this cycle.'); return; }
      for (const opp of opps) { await sendTelegram(formatAlert(opp)); await sleep(500); }
    } catch (e) { console.error('Scan error:', e.message); }
  };

  await run();
  setInterval(run, SCAN_INTERVAL_MS);
}

main().catch(console.error);
