## v1.9 — 7-Bug Audit Fix (5-AI Review)
Date: June 2026 | Phase: 1

Fixed (caught by running code through 5 different AIs):
1. ERC20_ABI undefined → silent crash in V3 TVL fallback
2. Nested loop → checks ALL buy/sell pool combos (not just min/max)
3. Alert cooldown → 10min per pair prevents Telegram spam
4. Alt buy pool bug → broken pool substitution removed
5. BigInt precision → V3 L values exceed JS safe integer (2^53)
   Now uses BigInt arithmetic, converts only after decimal division
6. activeOnly → renamed to isV3 (property was never actually set)
7. Flash fee → configurable: AAVE (0.09%) or BALANCER (0%)

Added: isScanning guard, recursive setTimeout, batched RPC
20/batch 400ms gap, sAMM excluded from non-stable pairs,
total fee pre-check (buy+sell+flash must be < gap),
MIN_GAP=0.3%, MIN_LIQ=$10k, SCAN_INTERVAL=120s

## v1.10 — Balancer + Public RPC Fix
Date: June 2026 | Phase: 1

Changed:
- Default flash protocol: Aave → Balancer (0% fee)
  Minimum profitable gap drops from 0.40% to 0.31%
  for V3 0.01% → V2 routes
- Discovery sleep: 150ms → 500ms
  Public RPC (mainnet.base.org) needs more time between
  factory calls than Alchemy or many pools are missed

## v1.11 — Google Sheets Logging
Date: June 2026 | Phase: 1

Added:
- Google Sheets logging via Apps Script webhook
- SHEETS_WEBHOOK_URL env var (set in Railway variables)
- 3 sheets auto-created: Scans (per cycle summary),
  Signals (profitable opportunities), Pool Prices (every
  pool's price/liquidity every scan)
- Non-blocking: Sheets failure never crashes the bot
- Debug pool log shows null count and liquidity range
  per scan: "23 null (RPC fail) | 144 got data | liq $0-$2.2M"

## v1.12 — Pool Detail Logging + Sheets Debug
Date: June 2026 | Phase: 1

Added:
- Per-pair pool table printed to Railway console each scan:
  Shows every active pool with DEX name, version, price,
  fee%, TVL, and Active liquidity (V3 shows both separately)
  Format:
  ┌── WETH/USDC │ 11 pools │ raw gap: 0.751%
  │  Uniswap V3 0.01%  $1575.98  fee:0.01%  TVL:$2.1M  Active:$45k
  │  Aerodrome vAMM    $1576.25  fee:0.30%  Liq:$4.2M
  └──────────────────────────────────────────────────────
- Startup Sheets connection test on boot
- Sheets response now logged ("OK" or exact error message)
- Sheets errors now visible in Railway console instead of
  being swallowed silently

## Build Plan Reference (updated)
| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Multi-pair monitoring, accurate signals | 🔄 Active (v1.12) |
| 2 | Event-driven scanning (WebSocket Swap events) | ⬜ Next |
| 3 | Solidity flash loan contract (Balancer) | ⬜ Pending |
| 4 | Paper trading on testnet | ⬜ Pending |
| 5 | Live execution + Flashbots | ⬜ Pending |
| 6 | Automation, MEV protection, scaling | ⬜ Pending |

# Ghost Arb Monitor — Changelog

All notable changes to this project are documented here.
Format: Version → What changed → Why it was needed.

## v1.8 — Fee Pre-Check Fix
Date: June 2026 | Phase: 1

### Fixed
- CRITICAL: Bot was picking V3 1% pool as buy source because 
  it had lowest spot price. But 1% trading fee > any realistic 
  gap. Result: 24hrs of correct rejections, zero signals ever.
  Fix: if buyPool.fee >= gap%, skip immediately. Then try 
  second-cheapest pool as buy instead.
- Version numbering corrected: v4.x → v1.x 
  (v1 = Phase 1 monitoring. v2 = Phase 2, etc.)
- TVL and active liquidity now shown separately in price logs
  for V3 pools: [TVL:$2.1M|Act:$45k]

## v1.7 — Full Code Audit
## v1.6 — sAMM Fix  
## v1.5 — WETH/USDC Debug Mode
## v1.4 — TVL Filter + Active Slippage Split
## v1.3 — Batched RPC Calls
## v1.2 — Active V3 Liquidity + 12 Pairs
## v1.1 — V3 Price Calculation Fix
## v1.0 — First Working Monitor (auto pool discovery)

---

## v4.4 — Active + TVL Split Fix
**Date:** June 2026
**Phase:** 1 (Monitoring)

### Added
- `balanceOf()` calls on both tokens to get real Total Value Locked (TVL)
- TVL now used for **filter decisions** (does this pool have enough depth to matter?)
- Active liquidity (`liquidity()` + sqrtPrice math) used for **slippage simulation only**
- Fallback: if active liquidity is 0 (price moved to empty tick), use 2% of TVL as conservative estimate instead of dropping pool entirely
- formatAlert now shows both Active Liq and TVL separately

### Fixed
- **Fault 1:** v4.2 used active liquidity for filtering. A $2M pool with $8k active would fail the $50k filter and get dropped. Now TVL is used for filtering — pool stays in comparison, slippage math still uses $8k.
- **Fault 2:** ETH price cascade wipe. When WETH/USDC V3 pools got dropped by Fault 1, ETH price never refreshed. Meme coin pairs (BRETT, DEGEN, TOSHI) that need ETH price for USD conversion returned 0 → also dropped. Fix: ETH/BTC price always updates from raw unfiltered pool list.
- **Fault 3:** `liquidity() = 0` caused immediate null return. Now falls back to 2% TVL estimate so the pool stays visible for gap detection.

### Why
v4.2's active liquidity fix was philosophically correct but broke the filter logic. A pool should be included in gap scanning based on whether it has *total* depth, but slippage should be calculated on *active* depth. These are two different questions.

---

## v4.3 — Batched RPC + Lower Thresholds
**Date:** June 2026
**Phase:** 1 (Monitoring)

### Fixed
- **Rate limit cascade:** `Promise.all` on 172 pools = 516 simultaneous RPC calls to Alchemy. Free tier choked, all calls returned null, "0 pools pass" on alternate scans. Fixed by batching 25 pools at a time with 300ms gap between batches.
- **Log message bug:** "filtered X below threshold" included pools that returned null from RPC errors — misleading. Now shows: `Active pools: X | RPC failed: Y | Below threshold: Z`

### Changed
- `MIN_LIQUIDITY_USD` default: $50,000 → $10,000
- Meme coin min liquidity: $100,000 → $20,000
- Reason: v4.2 was filtering out real pools (like Uniswap V3 1%) that had thin active liquidity, killing gap detection entirely

---

## v4.2 — Active V3 Liquidity Fix + 12 Pairs
**Date:** June 2026
**Phase:** 1 (Monitoring)

### Added
- 6 new token addresses: USDT, DAI, BRETT, DEGEN, TOSHI (all verified on basescan.org)
- 6 new pairs: WETH/USDT, USDC/USDT, DAI/USDC, BRETT/WETH, DEGEN/WETH, TOSHI/WETH (total: 12)
- `liquidity()` call on V3 pools to get active liquidity L
- Active virtual reserves computed from L: `x = L/sqrtP`, `y = L*sqrtP`
- Global `ethUsdPrice` and `btcUsdPrice` — updated each scan from WETH/USDC and cbBTC/USDC pools
- `computeLiquidityUSD()` helper supporting all token types including WETH-priced meme coins
- Per-pair `minLiquidity` field in WATCH_PAIRS
- V3 profit gets 20% safety haircut (tick-crossing risk) and marked as `(est.)`
- V3 max trade size capped at 5% of active reserves (vs 10% for V2)
- `getTokenUsdPrice()` helper for USDC/USDT/DAI/WETH/WBTC/cbBTC

### Fixed
- V3 liquidity was reading `balanceOf()` = total TVL of entire pool. A $30M pool showed $30M liquidity but only $500k was tradeable at current price. Slippage was massively understated, profits overstated.
- `findBestTradeSize` had a hardcoded fallback for V3 that ignored pool size. Now uses actual active reserves.
- `profitUSD` now correctly converts non-USDC profits (WETH pairs → × ethUsdPrice)

### Known issues introduced
- Active liquidity used for filtering (Fault 1) — fixed in v4.4
- Rate limit vulnerability (Fault 2) — partially fixed in v4.3

---

## v4.1 — V3 Price Fix + Sanity Filter
**Date:** June 2026
**Phase:** 1 (Monitoring)

### Added
- `sqrtPriceX96ToHumanPrice()` — correct V3 price derivation from sqrtPriceX96
- Sanity filter: gaps above 50% auto-rejected (these are bad price data, not real arb)
- Real x, y, k values fetched from blockchain for both V2 and V3
- Slippage-adjusted profit estimate

### Fixed
- V3 pool prices were wrong — used raw sqrtPriceX96 directly instead of squaring and adjusting for decimals
- Profit estimates ignored slippage entirely (assumed 0 price impact)

### Known issues
- V3 liquidity still using `balanceOf()` (TVL, not active)
- All 172 pool calls fired simultaneously → rate limit risk

---

## v4.0 — Auto Pool Discovery
**Date:** June 2026
**Phase:** 1 (Monitoring)

### Added
- Factory contract querying instead of hardcoded pool addresses
- Automatic pool discovery across 10 DEXes: Uniswap V2/V3, SushiSwap V2/V3, Aerodrome, PancakeSwap V2/V3, BaseSwap, AlienBase, SwapBased
- Aerodrome sAMM and vAMM support
- 6 initial pairs: WETH/USDC, cbETH/WETH, WBTC/WETH, cbBTC/WETH, cbBTC/WBTC, cbBTC/USDC
- Telegram alerts via MyAirdropBot (HTML parse mode)
- DexScreener API fallback for price data

### Why
Manual pool address management doesn't scale. Factory querying finds all pools automatically and adapts when new pools are created.

---

## Build Plan Reference

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Multi-pair monitoring, accurate signals | 🔄 Active (v4.x) |
| 2 | Event-driven scanning (Swap events, not polling) | ⬜ Next |
| 3 | Solidity flash loan contract | ⬜ Pending |
| 4 | Paper trading (simulate execution, no real money) | ⬜ Pending |
| 5 | Live execution + Flashbots bundles | ⬜ Pending |
| 6 | Automation, scaling, MEV protection | ⬜ Pending |

---

*Repository: github.com/Egbo007/Ghost-arb-testing*
*Chain: Base (L2 Ethereum)*
*Stack: Node.js, ethers.js v6, Railway hosting, Alchemy RPC*
