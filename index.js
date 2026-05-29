const fetch = require('node-fetch');

// ── CONFIG ────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MIN_GAP_PERCENT    = parseFloat(process.env.MIN_GAP_PERCENT || '1.0');
const CHECK_INTERVAL     = parseInt(process.env.CHECK_INTERVAL || '300000');

// ── NEW: Add your Google Apps Script URL here ─────────────
// Leave empty until you set up the Sheet (instructions below)
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || '';

// ── TOKENS TO WATCH ───────────────────────────────────────
const WATCH_TOKENS = [
  { symbol: 'WETH',  address: '0x4200000000000000000000000000000000000006' },
  { symbol: 'cbETH', address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22' },
  { symbol: 'WBTC',  address: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c' },
  { symbol: 'USDC',  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  { symbol: 'DAI',   address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb' },
  { symbol: 'USDT',  address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2' },
];

const WATCHED_DEXES = ['uniswap', 'aerodrome', 'sushiswap', 'pancakeswap', 'balancer', 'baseswap'];

// ── NEW: STALENESS TRACKER ────────────────────────────────
// Remembers the last price seen for every buy-side pool.
// Format: { "cbETH/WETH_aerodrome_buy": { price: 2250.53, count: 5 } }
// If the same pool shows the same price 2+ cycles in a row = stale = skip it.
const priceHistory = {};

function isBuyPoolStale(pairName, buyDex, buyPrice) {
  const key = `${pairName}_${buyDex}_buy`;

  if (!priceHistory[key]) {
    // First time seeing this pool — store it, not stale yet
    priceHistory[key] = { price: buyPrice, count: 1 };
    return false;
  }

  if (priceHistory[key].price === buyPrice) {
    // Same price as last time — increment stale counter
    priceHistory[key].count += 1;
    console.log(`  ⏸  Stale pool detected: ${key} | Price unchanged for ${priceHistory[key].count} cycles`);
    // Stale after 2 cycles (10 minutes at default interval)
    return priceHistory[key].count >= 2;
  } else {
    // Price changed — reset. This pool is alive again.
    priceHistory[key] = { price: buyPrice, count: 1 };
    return false;
  }
}

// ── NEW: AUTO-LOG TO GOOGLE SHEETS ───────────────────────
// Sends one row of data to your Google Apps Script webhook.
// Your Sheet gets a new row automatically every time a real signal fires.
async function logToSheets(opp, verdict) {
  if (!SHEETS_WEBHOOK_URL) return; // skip if not configured yet

  try {
    await fetch(SHEETS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp:  new Date().toISOString(),
        pair:       opp.pair,
        gapPct:     opp.gapPct,
        netProfit:  opp.netProfit,
        buyDex:     opp.buyDex,
        buyPrice:   opp.buyPrice,
        buyLiq:     Math.round(opp.buyLiq),
        sellDex:    opp.sellDex,
        sellPrice:  opp.sellPrice,
        sellLiq:    Math.round(opp.sellLiq),
        verdict:    verdict,  // EXECUTE / WATCH / SKIP from AI
        profitable: opp.profitable,
      })
    });
    console.log(`  📊 Logged to Sheets: ${opp.pair}`);
  } catch (e) {
    console.error('  ❌ Sheets log failed:', e.message);
  }
}

// ── AI ANALYSIS ───────────────────────────────────────────
async function analyzeOpportunity(opp) {
  if (!OPENROUTER_API_KEY) return 'AI analysis disabled.';
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-3.1-8b-instruct:free',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `You are a DeFi arbitrage analyst. Analyze this opportunity on Base chain.

OPPORTUNITY DATA:
- Pair: ${opp.pair}
- Price Gap: ${opp.gapPct}%
- Net profit after all fees: ${opp.netProfit}%
- BUY on: ${opp.buyDex} at $${opp.buyPrice}
- SELL on: ${opp.sellDex} at $${opp.sellPrice}
- Buy side liquidity: $${Math.round(opp.buyLiq).toLocaleString()}
- Sell side liquidity: $${Math.round(opp.sellLiq).toLocaleString()}
- All prices seen: ${opp.allDexes}

Reply in this exact format:
VERDICT: [EXECUTE or WATCH or SKIP]
REASON: [one sentence]
RISK: [main risk in a few words]
CONFIDENCE: [High or Medium or Low]`
        }]
      })
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || 'No analysis returned';
  } catch (e) {
    console.error('AI error:', e.message);
    return 'AI analysis failed';
  }
}

// ── TELEGRAM ──────────────────────────────────────────────
async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      })
    });
  } catch (e) { console.error('Telegram error:', e.message); }
}

// ── FETCH FROM DEXSCREENER ────────────────────────────────
async function fetchBasePairs(tokenAddress) {
  try {
    const res  = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    const data = await res.json();
    return (data.pairs || []).filter(p =>
      p.chainId === 'base' &&
      p.priceUsd &&
      parseFloat(p.liquidity?.usd || 0) > 10000
    );
  } catch (e) {
    console.error('DexScreener error:', e.message);
    return [];
  }
}

// ── GROUP BY PAIR NAME ────────────────────────────────────
function groupPairsByName(pairs) {
  const groups = {};
  for (const pair of pairs) {
    const dexId = pair.dexId?.toLowerCase() || '';
    if (!WATCHED_DEXES.some(d => dexId.includes(d))) continue;
    const key = `${pair.baseToken.symbol}/${pair.quoteToken.symbol}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push({
      dex:       pair.dexId,
      price:     parseFloat(pair.priceUsd),
      liquidity: parseFloat(pair.liquidity?.usd || 0),
      volume24h: parseFloat(pair.volume?.h24 || 0),
    });
  }
  return groups;
}

// ── SCAN FOR OPPORTUNITIES ────────────────────────────────
async function scanForOpportunities() {
  console.log(`\n[${new Date().toISOString()}] Scanning...`);
  const found = [];

  for (const token of WATCH_TOKENS) {
    const pairs  = await fetchBasePairs(token.address);
    const groups = groupPairsByName(pairs);

    for (const [pairName, entries] of Object.entries(groups)) {
      if (entries.length < 2) continue;

      const sorted  = [...entries].sort((a, b) => a.price - b.price);
      const lowest  = sorted[0];
      const highest = sorted[sorted.length - 1];
      const gapPct  = ((highest.price - lowest.price) / lowest.price) * 100;

      if (gapPct >= MIN_GAP_PERCENT) {

        // ── NEW: STALENESS CHECK ──────────────────────────
        // Before doing anything, check if the buy pool price is frozen.
        // If it hasn't moved in 2+ cycles, it's a dead pool — skip entirely.
        if (isBuyPoolStale(pairName, lowest.dex, lowest.price)) {
          console.log(`  🚫 Skipped (stale buy pool): ${pairName} | ${lowest.dex} @ $${lowest.price}`);
          continue; // skip this signal — don't alert, don't log
        }
        // ─────────────────────────────────────────────────

        const netProfit = gapPct - 0.09 - 0.6;
        found.push({
          pair:      pairName,
          buyDex:    lowest.dex,
          buyPrice:  lowest.price,
          buyLiq:    lowest.liquidity,
          sellDex:   highest.dex,
          sellPrice: highest.price,
          sellLiq:   highest.liquidity,
          gapPct:    gapPct.toFixed(3),
          netProfit: netProfit.toFixed(3),
          profitable: netProfit > 0,
          allDexes:  entries.map(e => `${e.dex} @ $${e.price.toFixed(6)}`).join('\n')
        });
      }
    }

    await new Promise(r => setTimeout(r, 400));
  }
  return found;
}

// ── FORMAT TELEGRAM ALERT ─────────────────────────────────
function formatAlert(opp, aiAnalysis) {
  const emoji = opp.profitable ? '🟢' : '🟡';
  return `${emoji} <b>ARB SIGNAL DETECTED</b>

📊 <b>Pair:</b> ${opp.pair}
📐 <b>Price Gap:</b> ${opp.gapPct}%
💸 <b>Net after fees:</b> ${opp.netProfit}%

🔻 <b>BUY on</b> ${opp.buyDex}
   $${opp.buyPrice.toFixed(6)}
   Liquidity: $${Math.round(opp.buyLiq).toLocaleString()}

🔺 <b>SELL on</b> ${opp.sellDex}
   $${opp.sellPrice.toFixed(6)}
   Liquidity: $${Math.round(opp.sellLiq).toLocaleString()}

🏪 <b>All DEX prices:</b>
${opp.allDexes}

🤖 <b>AI Verdict:</b>
${aiAnalysis}

⏰ ${new Date().toUTCString()}`;
}

// ── MAIN LOOP ─────────────────────────────────────────────
async function main() {
  console.log('=================================');
  console.log('  Ghost Arb Monitor v2.1 started');
  console.log('  + Staleness filter ON');
  console.log('  + Auto Sheets logging ' + (SHEETS_WEBHOOK_URL ? 'ON' : 'OFF (add SHEETS_WEBHOOK_URL)'));
  console.log('=================================');

  await sendTelegram(`🤖 <b>Ghost Arb Monitor v2.1 is LIVE</b>

✅ Staleness filter: ON (dead pools skipped after 2 cycles)
${SHEETS_WEBHOOK_URL ? '✅' : '⏳'} Auto Sheets logging: ${SHEETS_WEBHOOK_URL ? 'ON' : 'OFF — add SHEETS_WEBHOOK_URL to enable'}

Watching: ${WATCH_TOKENS.map(t => t.symbol).join(', ')}
Min gap: ${MIN_GAP_PERCENT}% | Every ${CHECK_INTERVAL/60000} mins`);

  const run = async () => {
    const opps = await scanForOpportunities();

    if (opps.length === 0) {
      console.log('No live opportunities this cycle.');
      return;
    }

    console.log(`Found ${opps.length} live opportunity(s)!`);

    for (const opp of opps) {
      console.log(`  → ${opp.pair} | Gap: ${opp.gapPct}% | Net: ${opp.netProfit}%`);
      const aiAnalysis = await analyzeOpportunity(opp);

      // Extract just the verdict word for the Sheet (EXECUTE / WATCH / SKIP)
      const verdictLine = aiAnalysis.match(/VERDICT:\s*(\w+)/i);
      const verdict = verdictLine ? verdictLine[1] : 'UNKNOWN';

      // Send Telegram alert
      await sendTelegram(formatAlert(opp, aiAnalysis));

      // NEW: Auto-log to Google Sheets
      await logToSheets(opp, verdict);
    }
  };

  await run();
  setInterval(run, CHECK_INTERVAL);
}

main().catch(console.error);
