const fetch = require('node-fetch');

// ── CONFIG (set these as Railway environment variables) ───
const TELEGRAM_BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID    = process.env.TELEGRAM_CHAT_ID;
const OPENROUTER_API_KEY  = process.env.OPENROUTER_API_KEY; // free — you already have this
const MIN_GAP_PERCENT     = parseFloat(process.env.MIN_GAP_PERCENT || '1.0');
const CHECK_INTERVAL      = parseInt(process.env.CHECK_INTERVAL || '300000'); // 5 minutes

// ── TOKENS TO WATCH ON BASE CHAIN ────────────────────────
const WATCH_TOKENS = [
  { symbol: 'WETH',  address: '0x4200000000000000000000000000000000000006' },
  { symbol: 'cbETH', address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22' },
  { symbol: 'WBTC',  address: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c' },
  { symbol: 'USDC',  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  { symbol: 'DAI',   address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb' },
  { symbol: 'USDT',  address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2' },
];

// ── DEXes TO MONITOR ──────────────────────────────────────
const WATCHED_DEXES = ['uniswap', 'aerodrome', 'sushiswap', 'pancakeswap', 'balancer', 'baseswap'];

// ── AI ANALYSIS (uses OpenRouter free model) ──────────────
// This is the "Hermes" brain of the system.
// When a price gap is found, it asks AI: is this real? worth it? what's the risk?
async function analyzeOpportunity(opp) {
  if (!OPENROUTER_API_KEY) {
    return 'AI analysis disabled. Add OPENROUTER_API_KEY to enable.';
  }
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
    return 'AI analysis failed — check logs';
  }
}

// ── SEND TELEGRAM MESSAGE ─────────────────────────────────
async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('Telegram not configured');
    return;
  }
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

// ── FETCH PRICES FROM DEXSCREENER ────────────────────────
// DexScreener is free — no API key needed
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

// ── GROUP PRICES BY PAIR NAME ─────────────────────────────
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

// ── SCAN ALL TOKENS FOR GAPS ──────────────────────────────
async function scanForOpportunities() {
  console.log(`\n[${new Date().toISOString()}] Scanning ${WATCH_TOKENS.length} tokens across ${WATCHED_DEXES.length} DEXes...`);
  const found = [];

  for (const token of WATCH_TOKENS) {
    const pairs  = await fetchBasePairs(token.address);
    const groups = groupPairsByName(pairs);

    for (const [pairName, entries] of Object.entries(groups)) {
      if (entries.length < 2) continue; // need at least 2 DEXes to compare

      // Sort by price: lowest first
      const sorted  = [...entries].sort((a, b) => a.price - b.price);
      const lowest  = sorted[0];
      const highest = sorted[sorted.length - 1];

      // Calculate the gap between cheapest and most expensive DEX
      const gapPct = ((highest.price - lowest.price) / lowest.price) * 100;

      if (gapPct >= MIN_GAP_PERCENT) {
        // Subtract: Aave flash loan fee (0.09%) + two DEX swap fees (0.3% each)
        const netProfit = gapPct - 0.09 - 0.6;
        found.push({
          pair: pairName,
          buyDex: lowest.dex,   buyPrice: lowest.price,   buyLiq: lowest.liquidity,
          sellDex: highest.dex, sellPrice: highest.price, sellLiq: highest.liquidity,
          gapPct: gapPct.toFixed(3),
          netProfit: netProfit.toFixed(3),
          profitable: netProfit > 0,
          allDexes: entries.map(e => `${e.dex} @ $${e.price.toFixed(6)}`).join('\n')
        });
      }
    }

    // Small pause so we don't hammer DexScreener
    await new Promise(r => setTimeout(r, 400));
  }
  return found;
}

// ── FORMAT THE TELEGRAM ALERT ─────────────────────────────
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
  console.log('  Ghost Arb Monitor v2.0 started');
  console.log('=================================');
  console.log(`Min gap:  ${MIN_GAP_PERCENT}%`);
  console.log(`Interval: every ${CHECK_INTERVAL / 60000} minutes`);
  console.log(`AI:       ${OPENROUTER_API_KEY ? 'ENABLED (OpenRouter free)' : 'DISABLED'}`);

  await sendTelegram(`🤖 <b>Ghost Arb Monitor v2.0 is LIVE</b>

Watching Base chain every ${CHECK_INTERVAL/60000} mins
Tokens: ${WATCH_TOKENS.map(t => t.symbol).join(', ')}
DEXes: ${WATCHED_DEXES.join(', ')}
Min gap: ${MIN_GAP_PERCENT}%
AI Analysis: ${OPENROUTER_API_KEY ? '✅ ON (free)' : '❌ OFF'}`);

  const run = async () => {
    const opps = await scanForOpportunities();

    if (opps.length === 0) {
      console.log('No opportunities this cycle. Will check again in', CHECK_INTERVAL/60000, 'minutes.');
      return;
    }

    console.log(`Found ${opps.length} opportunity(s)! Analyzing with AI...`);

    for (const opp of opps) {
      console.log(`  → ${opp.pair} | Gap: ${opp.gapPct}% | Net: ${opp.netProfit}%`);
      const aiAnalysis = await analyzeOpportunity(opp);
      await sendTelegram(formatAlert(opp, aiAnalysis));
    }
  };

  // Run immediately when bot starts
  await run();

  // Then repeat on schedule
  setInterval(run, CHECK_INTERVAL);
}

main().catch(console.error);
