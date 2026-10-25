import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.js";
import { log } from "../logger.js";
import { getPoolMetadata } from "./dlmm.js";
import {
  getTrackedPosition,
  markOutOfRange,
  markInRange,
  minutesOutOfRange,
  getTrackedPositions,
} from "../state.js";

// ─── Public-infra PnL engine (opt-in / emergency fallback) ──────
// Default pnl.source is "meteora": the poller reads the full precomputed
// data from the Meteora portfolio + /pnl APIs with no per-tick RPC reads.
// This on-chain engine runs only when pnl.source=rpc or as the last-resort
// fallback while the Meteora APIs are unreachable. Live position value
// (current liquidity + claimable fees) is read ON-CHAIN via the Meteora DLMM
// SDK on a public RPC (pump.helius). Deposit history (cost basis,
// withdrawals, claimed fees) comes ONLY from the Meteora /pnl API — its
// precomputed live pnl/balances are intentionally ignored here. Token USD
// prices come from Jupiter. No LPAgent / agentmeridian dependency.

const JUP_SEARCH = "https://datapi.jup.ag/v1/assets/search";
const METEORA_PNL = "https://dlmm.datapi.meteora.ag/positions";

// ─── Cached position discovery (like neo/meridian) ─────────────────
// PositionV2 account layout: discriminator(8) + lb_pair(32) + owner(32) = 72 bytes head
const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const POSITION_V2_DISCRIMINATOR = Buffer.from("75b0d4c7f5b485b6", "hex");
const POSITION_HEAD_LEN = 72;
const POSITION_DISCOVERY_INTERVAL_MS = 5 * 60_000; // full getProgramAccounts every 5 min
let _knownPositionAccounts = new Map(); // position → lb_pair, from last discovery scan
let _lastPositionDiscoveryAt = 0;
// Cached full position data (liquidity amounts, bin bounds) — refreshed during discovery
let _cachedFlat = null;
let _cachedFlatAt = 0;

export function invalidatePositionCache() {
  _cachedFlat = null;
  _cachedFlatAt = 0;
  _lastPositionDiscoveryAt = 0;
  log("pnl", "Position cache invalidated");
}

function positionAccountFilters(owner) {
  return [
    { memcmp: { offset: 0, bytes: bs58.encode(POSITION_V2_DISCRIMINATOR) } },
    { memcmp: { offset: 40, bytes: owner.toBase58() } },
  ];
}

/** lb_pair of a PositionV2 account owned by `owner`, or null (closed / not a position / not ours). */
function positionHeadPool(info, owner) {
  if (!info?.data || !info.owner?.equals?.(DLMM_PROGRAM_ID)) return null;
  const d = Buffer.from(info.data);
  if (d.length < POSITION_HEAD_LEN) return null;
  if (!d.subarray(0, 8).equals(POSITION_V2_DISCRIMINATOR)) return null;
  if (!d.subarray(40, 72).equals(owner.toBuffer())) return null;
  return new PublicKey(d.subarray(8, 40)).toBase58();
}

/**
 * The wallet's open DLMM position accounts → [{ position, pool }].
 * Uses cached discovery: full getProgramAccounts every 5 min, cheap getMultipleAccountsInfo in between.
 */
async function listPositionAccounts(owner, { discover = false, trackedOpen = null, now = Date.now() } = {}) {
  const connection = getPnlConnection();
  if (discover || now - _lastPositionDiscoveryAt >= POSITION_DISCOVERY_INTERVAL_MS) {
    const accs = await connection.getProgramAccounts(DLMM_PROGRAM_ID, {
      filters: positionAccountFilters(owner),
      dataSlice: { offset: 0, length: POSITION_HEAD_LEN },
    });
    const found = new Map();
    for (const a of accs) {
      const pool = positionHeadPool({ owner: DLMM_PROGRAM_ID, data: a.account.data }, owner);
      if (pool) found.set(a.pubkey.toBase58(), pool);
    }
    _knownPositionAccounts = found;
    _lastPositionDiscoveryAt = now;
    return [...found].map(([position, pool]) => ({ position, pool }));
  }

  const tracked = trackedOpen ?? getTrackedPositions(true).map((p) => p.position);
  const keys = [...new Set([...tracked, ..._knownPositionAccounts.keys()])];
  if (keys.length === 0) return [];
  const infos = [];
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100).map((k) => new PublicKey(k));
    infos.push(...await connection.getMultipleAccountsInfo(batch, { dataSlice: { offset: 0, length: POSITION_HEAD_LEN } }));
  }
  const out = [];
  keys.forEach((position, i) => {
    const pool = positionHeadPool(infos[i], owner);
    if (pool) {
      out.push({ position, pool });
      _knownPositionAccounts.set(position, pool);
    } else {
      _knownPositionAccounts.delete(position);
    }
  });
  return out;
}

// Lazy SDK load — mirrors tools/dlmm.js (CJS dir-imports break in ESM at import time).
let _DLMM = null;
async function loadDlmmSdk() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
  }
  return _DLMM;
}

let _pnlConnection = null;
export function getPnlConnection() {
  if (!_pnlConnection) {
    _pnlConnection = new Connection(config.pnl.rpcUrl, "confirmed");
  }
  return _pnlConnection;
}

function safeNum(value) {
  const n = parseFloat(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function maybeNum(value) {
  if (value == null || value === "") return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}
function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

// ─── Meteora /pnl per pool (deposit history) ────────────────────
// Exported because tools/dlmm.js (getPositionPnl + the Meteora fallback path)
// also reads it.
export async function fetchDlmmPnlForPool(poolAddress, walletAddress) {
  const url = `${METEORA_PNL}/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("pnl_api", `HTTP ${res.status} for pool ${poolAddress.slice(0, 8)}: ${body.slice(0, 120)}`);
      return {};
    }
    const data = await res.json();
    const positions = data.positions || data.data || [];
    const byAddress = {};
    for (const p of positions) {
      const addr = p.positionAddress || p.address || p.position;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e) {
    log("pnl_api", `Fetch error for pool ${poolAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

// ─── Jupiter prices (never cached) ──────────────────────────────
async function getJupiterPrices(mints) {
  const list = unique(mints.map((m) => String(m).trim()));
  if (!list.length) return {};
  try {
    const res = await fetch(`${JUP_SEARCH}?query=${list.join(",")}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Jupiter ${res.status}`);
    const assets = await res.json();
    const out = {};
    for (const a of assets) out[a.id] = maybeNum(a.usdPrice);
    return out;
  } catch (e) {
    log("pnl_price", `Jupiter price fetch failed: ${e.message}`);
    return {};
  }
}

// ─── Deposit-history cache (sig-invalidated + TTL) ──────────────
// Deposits/withdrawals/claimed fees change only on a position tx; feePerTvl24h
// is a slow 24h pool stat. Cache per pool, refetch when any position's latest
// signature changes or the TTL lapses.
const _meteoraCache = new Map(); // pool -> { at, byPosition, sigByPosition }
let _pollCount = 0;

async function getLatestSig(conn, addr) {
  try {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(addr), { limit: 1 });
    return sigs?.[0]?.signature ?? null;
  } catch {
    return null;
  }
}

async function getMeteoraData(conn, walletAddress, flat) {
  const ttlMs = Math.max(0, Number(config.pnl.depositCacheTtlSec ?? 300)) * 1000;
  const positionsByPool = new Map();
  for (const f of flat) {
    if (!positionsByPool.has(f.pool)) positionsByPool.set(f.pool, []);
    positionsByPool.get(f.pool).push(f.position);
  }

  const byPosition = {};
  await Promise.all([...positionsByPool.entries()].map(async ([pool, positionAddrs]) => {
    const cached = _meteoraCache.get(pool);
    const sigByPosition = {};
    await Promise.all(positionAddrs.map(async (addr) => { sigByPosition[addr] = await getLatestSig(conn, addr); }));

    const ageOk = cached && Date.now() - cached.at < ttlMs;
    const sigsMatch = cached && positionAddrs.every((a) => cached.sigByPosition?.[a] === sigByPosition[a]);

    let data;
    if (ageOk && sigsMatch) {
      data = cached.byPosition;
    } else {
      data = await fetchDlmmPnlForPool(pool, walletAddress);
      _meteoraCache.set(pool, { at: Date.now(), byPosition: data, sigByPosition });
    }
    for (const addr of positionAddrs) byPosition[addr] = data[addr] || null;
  }));

  return byPosition;
}

function mapEntries(map) {
  return map instanceof Map ? [...map.entries()] : Object.entries(map || {});
}

// ─── Build the shaped position object (matches getMyPositions output) ──
async function buildPosition(f, prices, solUsd, meteora, solMode) {
  const priceX = f.baseMint ? (prices[f.baseMint] ?? 0) : 0;

  const xHuman = safeNum(f.xRaw) / 10 ** f.decX;
  const yHuman = safeNum(f.yRaw) / 10 ** f.decY;
  const balancesUsd = xHuman * priceX + yHuman * (solUsd ?? 0);
  const balancesSol = solUsd ? balancesUsd / solUsd : yHuman;

  const feeXHuman = safeNum(f.feeXRaw) / 10 ** f.decX;
  const feeYHuman = safeNum(f.feeYRaw) / 10 ** f.decY;
  const claimableUsd = feeXHuman * priceX + feeYHuman * (solUsd ?? 0);
  const claimableSol = solUsd ? claimableUsd / solUsd : feeYHuman;

  const depositsUsd = safeNum(meteora?.allTimeDeposits?.total?.usd);
  const depositsSol = safeNum(meteora?.allTimeDeposits?.total?.sol);
  const withdrawUsd = safeNum(meteora?.allTimeWithdrawals?.total?.usd);
  const withdrawSol = safeNum(meteora?.allTimeWithdrawals?.total?.sol);
  const claimedUsd = safeNum(meteora?.allTimeFees?.total?.usd);
  const claimedSol = safeNum(meteora?.allTimeFees?.total?.sol);

  const pnlUsd = balancesUsd + withdrawUsd + claimableUsd + claimedUsd - depositsUsd;
  const pnlSol = balancesSol + withdrawSol + claimableSol + claimedSol - depositsSol;
  const pctUsd = depositsUsd > 0 ? (pnlUsd / depositsUsd) * 100 : 0;
  const pctSol = depositsSol > 0 ? (pnlSol / depositsSol) * 100 : 0;

  const ourPct = solMode ? pctSol : pctUsd;

  // pnl_pct_diff is the gap vs Meteora's precomputed pct — kept ONLY as a logged
  // diagnostic. It is NOT used to gate exits: Meteora's pct comes from the
  // deposit cache (stale up to depositCacheTtlSec) while ourPct is fresh every
  // poll, so on a fast move the gap inflates and would falsely suppress
  // STOP_LOSS / TRAILING_TP exactly when they matter.
  const reportedPct = solMode ? maybeNum(meteora?.pnlSolPctChange) : maybeNum(meteora?.pnlPctChange);
  const pnlPctDiff = reportedPct != null ? Math.abs(ourPct - reportedPct) : null;

  // On-chain amounts are authoritative; a tick is "suspicious" (don't act on it)
  // only when we couldn't price it. Guards against:
  //  - Jupiter outage → solUsd/priceX missing → balances collapse → false STOP_LOSS
  //  - missing Meteora deposits → 0 cost basis → garbage pnl / inflated value
  const holdsTokenX = xHuman > 0 || feeXHuman > 0;
  const priceMissing = !(solUsd > 0) || (holdsTokenX && !!f.baseMint && !(priceX > 0));
  const depositsMissing = (solMode ? depositsSol : depositsUsd) <= 0;
  const pnlPctSuspicious = priceMissing || depositsMissing;
  if (pnlPctSuspicious) {
    log("pnl_warn", `${f.position.slice(0, 8)} suspicious tick — priceMissing=${priceMissing} depositsMissing=${depositsMissing} (solUsd=${solUsd}, priceX=${priceX})`);
  }

  const inRange = f.active != null && f.lower != null && f.upper != null
    ? f.active >= f.lower && f.active <= f.upper
    : (meteora ? !meteora.isOutOfRange : true);

  if (inRange) markInRange(f.position);
  else markOutOfRange(f.position);

  const tracked = getTrackedPosition(f.position);
  const ageFromState = tracked?.deployed_at
    ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
    : null;
  const ageMinutes = meteora?.createdAt ? Math.floor((Date.now() - meteora.createdAt * 1000) / 60000) : ageFromState;

  // Enrich meteora with token symbols from pool metadata if missing
  let enrichedMeteora = meteora;
  if (meteora && (!meteora.tokenX || !meteora.tokenY)) {
    try {
      const meta = await getPoolMetadata(f.pool);
      if (meta?.token_x_symbol || meta?.token_y_symbol) {
        enrichedMeteora = {
          ...meteora,
          tokenX: meteora.tokenX ?? meta.token_x_symbol,
          tokenY: meteora.tokenY ?? meta.token_y_symbol,
        };
      }
    } catch (e) {
      log("pnl_warn", `Failed to enrich pool metadata for ${f.pool.slice(0, 8)}: ${e.message}`);
    }
  }

  return {
    position:           f.position,
    pool:               f.pool,
    pair:               tracked?.pool_name || (enrichedMeteora ? `${enrichedMeteora.tokenX ?? "?"}/${enrichedMeteora.tokenY ?? "SOL"}` : "?/SOL"),
    base_mint:          f.baseMint,
    lower_bin:          f.lower ?? tracked?.bin_range?.min ?? null,
    upper_bin:          f.upper ?? tracked?.bin_range?.max ?? null,
    active_bin:         f.active ?? tracked?.bin_range?.active ?? null,
    in_range:           inRange,
    unclaimed_fees_usd: round(solMode ? claimableSol : claimableUsd),
    unclaimed_fees_true_usd: round(claimableUsd),
    total_value_usd:    round(solMode ? balancesSol : balancesUsd),
    total_value_true_usd: round(balancesUsd),
    collected_fees_usd: round(solMode ? claimedSol : claimedUsd),
    collected_fees_true_usd: round(claimedUsd),
    pnl_usd:            round(solMode ? pnlSol : pnlUsd),
    pnl_true_usd:       round(pnlUsd),
    pnl_pct:            round(ourPct, 2),
    pnl_pct_derived:    round(ourPct, 2),
    pnl_pct_diff:       pnlPctDiff != null ? round(pnlPctDiff, 2) : null,
    pnl_pct_suspicious: !!pnlPctSuspicious,
    fee_per_tvl_24h:    meteora ? Math.round(safeNum(meteora.feePerTvl24h) * 100) / 100 : null,
    age_minutes:        ageMinutes,
    minutes_out_of_range: minutesOutOfRange(f.position),
    instruction:        tracked?.instruction ?? null,
  };
}

// ─── Main entry: compute positions from public infra ────────────
// Returns the same shape as getMyPositions, or throws so the caller can
// fall back to the Meteora-API path.
export async function computePositions(walletAddress) {
  const solMode = !!config.management?.solMode;
  const SOL_MINT = config.tokens.SOL;
  const conn = getPnlConnection();
  const DLMM = await loadDlmmSdk();
  const walletPubkey = new PublicKey(walletAddress);

  // Check if we need to do full discovery (every 5 min)
  const now = Date.now();
  const needDiscovery = now - _lastPositionDiscoveryAt >= POSITION_DISCOVERY_INTERVAL_MS || _cachedFlat === null;

  let flat;
  if (needDiscovery) {
    // Full discovery: use SDK to get complete position data including liquidity amounts
    const map = await DLMM.getAllLbPairPositionsByUser(conn, walletPubkey);
    flat = [];
    for (const [lbPairKey, info] of mapEntries(map)) {
      const decX = info?.tokenX?.mint?.decimals ?? 9;
      const decY = info?.tokenY?.mint?.decimals ?? 9;
      const baseMint = info?.tokenX?.mint?.address?.toString?.() ?? null;
      const active = info?.lbPair?.activeId ?? null;
      for (const p of info?.lbPairPositionsData || []) {
        const d = p.positionData || {};
        flat.push({
          position: p.publicKey.toString(),
          pool: lbPairKey,
          baseMint,
          decX,
          decY,
          active,
          lower: d.lowerBinId ?? null,
          upper: d.upperBinId ?? null,
          xRaw: d.totalXAmount,
          yRaw: d.totalYAmount,
          feeXRaw: d.feeX?.toString?.() ?? d.feeX ?? 0,
          feeYRaw: d.feeY?.toString?.() ?? d.feeY ?? 0,
        });
      }
    }
    // Cache for next 5 minutes
    _cachedFlat = flat;
    _cachedFlatAt = now;
    _lastPositionDiscoveryAt = now;
  } else {
    // Use cached position data (liquidity amounts, bin bounds) — fresh prices & deposits fetched below
    flat = _cachedFlat || [];
  }

  _pollCount++;
  if (_pollCount % 20 === 1) {
    log("pnl_tick", `poller alive — ${flat.length} position(s) tracked (tick #${_pollCount})`);
  }

  if (flat.length === 0) {
    return { wallet: walletAddress, total_positions: 0, positions: [], source: "rpc" };
  }

  // Still run listPositionAccounts to update _knownPositionAccounts (cheap, no full scan)
  await listPositionAccounts(walletPubkey);

  const [prices, meteoraByPosition] = await Promise.all([
    getJupiterPrices([SOL_MINT, ...flat.map((f) => f.baseMint)]),
    getMeteoraData(conn, walletAddress, flat),
  ]);
  const solUsd = prices[SOL_MINT] ?? null;

  const positions = await Promise.all(flat.map((f) => buildPosition(f, prices, solUsd, meteoraByPosition[f.position], solMode)));

  return { wallet: walletAddress, total_positions: positions.length, positions, source: "rpc" };
}
