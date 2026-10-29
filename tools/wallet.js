import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";
import { walletCacheState, invalidateWalletBalances, WALLET_BALANCES_TTL_MS } from "./wallet-cache.js";

export { invalidateWalletBalances };

let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
  return _connection;
}

export function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";

function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

function getJupiterReferralParams() {
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

// ─── RPC-based wallet balances (no Helius Wallet API) ─────────────
// The Helius Wallet API costs 100 credits per call and was ~97% of the plan's
// spend. Balances now come from 3 RPC calls (getBalance + parsed token accounts
// for Token and Token-2022), prices from Jupiter Price v3 and symbols from
// Jupiter Tokens v2. USE_HELIUS_WALLET_API=true restores the old source.

const TOKEN_PROGRAM_IDS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
];
const PRICE_BATCH = 50; // Jupiter Price v3 max ids per request
export const SOL_PRICE_TTL_MS = 60_000;

const SOL_MINT = "So11111111111111111111111111111111111111112";

let _solPrice = null; // { at, price }
let _solPriceInflight = null;
const _symbols = new Map(); // mint -> symbol | null
let _testDeps = null;

/** Connection for balance reads from BALANCE_RPC_URL, or null when unset. */
function getBalanceConnection() {
  const url = process.env.BALANCE_RPC_URL;
  if (!url) return null;
  if (!_balanceConnection) _balanceConnection = new Connection(url, "confirmed");
  return _balanceConnection;
}
let _balanceConnection = null;

async function readHoldings(connection, owner) {
  const [lamports, ...tokenResults] = await Promise.all([
    connection.getBalance(owner, "confirmed"),
    ...TOKEN_PROGRAM_IDS.map((programId) =>
      connection.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(programId) }, "confirmed")),
  ]);
  if (lamports == null || !Number.isFinite(Number(lamports))) throw new Error("getBalance returned no value");
  const byMint = new Map(); // mint -> { raw: bigint, decimals }
  for (const res of tokenResults) {
    if (!res || !Array.isArray(res.value)) throw new Error("getParsedTokenAccountsByOwner returned no value");
    for (const { account } of res.value) {
      const info = account?.data?.parsed?.info;
      const amt = info?.tokenAmount;
      if (!info?.mint || amt?.amount == null || !/^\d+$/.test(String(amt.amount))) continue;
      const cur = byMint.get(info.mint) ?? { raw: 0n, decimals: Number.isInteger(amt.decimals) ? amt.decimals : 0 };
      cur.raw += BigInt(amt.amount);
      byMint.set(info.mint, cur);
    }
  }
  return { lamports: Number(lamports), byMint };
}

async function readHoldingsRouted(owner) {
  const balanceConn = getBalanceConnection();
  const mainConn = getConnection();
  if (!balanceConn) return readHoldings(mainConn, owner);
  try {
    return await readHoldings(balanceConn, owner);
  } catch (e) {
    log("wallet_warn", `Balance RPC failed (${e.message}); retrying on the main RPC`);
    return readHoldings(mainConn, owner);
  }
}

async function fetchJupiterPrices(mints) {
  const out = new Map();
  const ids = [...new Set(mints.filter(Boolean))];
  for (let i = 0; i < ids.length; i += PRICE_BATCH) {
    const chunk = ids.slice(i, i + PRICE_BATCH);
    try {
      const res = await fetch(`${JUPITER_PRICE_API}?ids=${chunk.join(",")}`, {
        headers: { "x-api-key": getJupiterApiKey() },
      });
      if (!res.ok) {
        log("wallet_warn", `Jupiter price request failed: HTTP ${res.status}`);
        continue;
      }
      const body = await res.json();
      for (const m of chunk) {
        const p = Number(body?.[m]?.usdPrice);
        if (Number.isFinite(p) && p > 0) out.set(m, p);
      }
    } catch (e) {
      log("wallet_warn", `Jupiter price request failed: ${e.message}`);
    }
  }
  if (out.has(SOL_MINT)) _solPrice = { at: Date.now(), price: out.get(SOL_MINT) };
  return out;
}

export async function getSolPrice() {
  if (_solPrice && Date.now() - _solPrice.at < SOL_PRICE_TTL_MS) return _solPrice.price;
  if (_solPriceInflight) return _solPriceInflight;
  const p = fetchJupiterPrices([SOL_MINT])
    .then((prices) => prices.get(SOL_MINT) ?? _solPrice?.price ?? 0)
    .finally(() => { if (_solPriceInflight === p) _solPriceInflight = null; });
  _solPriceInflight = p;
  return p;
}

async function resolveSymbols(mints) {
  const need = mints.filter((m) => !_symbols.has(m));
  if (need.length) {
    try {
      const res = await fetch(`https://api.jup.ag/tokens/v2/mint?ids=${need.join(",")}`, {
        headers: { "x-api-key": getJupiterApiKey() },
      });
      if (res.ok) {
        const data = await res.json();
        for (const m of need) _symbols.set(m, data?.[m]?.symbol || null);
      }
    } catch { /* fall back to mint prefix */ }
  }
  return (m) => _symbols.get(m) || m.slice(0, 8);
}

const round2 = (n) => Math.round(n * 100) / 100;

async function readWalletBalances(walletAddress) {
  const { lamports, byMint } = await readHoldingsRouted(new PublicKey(walletAddress));
  const held = [...byMint.entries()].filter(([, v]) => v.raw > 0n);
  const mints = held.map(([m]) => m);
  const [prices, symbolOf] = await Promise.all([
    fetchJupiterPrices([SOL_MINT, ...mints]),
    resolveSymbols(mints),
  ]);

  const solPrice = prices.get(SOL_MINT) ?? _solPrice?.price ?? 0;
  const sol = lamports / LAMPORTS_PER_SOL;
  const solUsd = sol * solPrice;
  const tokens = [{ mint: SOL_MINT, symbol: "SOL", balance: sol, usd: solPrice > 0 ? round2(solUsd) : null }];
  let totalUsd = solUsd;
  let usdc = 0;
  for (const [mint, { raw, decimals }] of held) {
    const balance = Number(raw) / 10 ** decimals;
    const price = prices.get(mint);
    const usd = price != null ? balance * price : null;
    if (usd != null) totalUsd += usd;
    if (mint === config.USDC) usdc = balance;
    tokens.push({
      mint,
      symbol: mint === SOL_MINT ? "WSOL" : symbolOf(mint),
      balance,
      usd: usd == null ? null : round2(usd),
    });
  }

  return {
    wallet: walletAddress,
    sol: Math.round(sol * 1e6) / 1e6,
    sol_price: round2(solPrice),
    sol_usd: round2(solUsd),
    usdc: round2(usdc),
    tokens,
    total_usd: round2(totalUsd),
  };
}

/** Legacy source (opt-in via USE_HELIUS_WALLET_API=true): 100 credits/call. */
async function readHeliusWalletBalances(walletAddress) {
  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) throw new Error("Helius API key missing");
  const res = await fetch(`https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`);
  if (!res.ok) throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const balances = data.balances || [];
  const solEntry = balances.find((b) => b.mint === config.SOL || b.symbol === "SOL");
  const usdcEntry = balances.find((b) => b.mint === config.USDC || b.symbol === "USDC");
  if (solEntry?.pricePerToken > 0) _solPrice = { at: Date.now(), price: solEntry.pricePerToken };
  return {
    wallet: walletAddress,
    sol: Math.round((solEntry?.balance || 0) * 1e6) / 1e6,
    sol_price: round2(solEntry?.pricePerToken || 0),
    sol_usd: round2(solEntry?.usdValue || 0),
    usdc: round2(usdcEntry?.balance || 0),
    tokens: balances.map((b) => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? round2(b.usdValue) : null,
    })),
    total_usd: round2(data.totalUsdValue || 0),
  };
}

const emptyBalances = (wallet, error) => ({ wallet, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error });

/**
 * Wallet balances: { wallet, sol, sol_price, sol_usd, usdc,
 * tokens: [{ mint, symbol, balance, usd }], total_usd } or the same shape with
 * `error` on failure. Cached for WALLET_BALANCES_TTL_MS (20s); every send
 * invalidates the cache (tx-send.js, swapToken). Pass { fresh: true } to skip
 * the cache when the read feeds a decision about moving funds.
 */
export async function getWalletBalances(opts) {
  const fresh = opts?.fresh === true;
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return emptyBalances(null, "Wallet not configured");
  }

  const c = walletCacheState();
  if (!fresh && c.entry && Date.now() - c.entry.at < WALLET_BALANCES_TTL_MS) return structuredClone(c.entry.value);
  if (!fresh && c.inflight) return c.inflight.then((v) => structuredClone(v));

  const gen = c.generation;
  const useHelius = process.env.USE_HELIUS_WALLET_API === "true";
  const p = (useHelius ? readHeliusWalletBalances(walletAddress) : readWalletBalances(walletAddress))
    .then((value) => {
      if (c.generation === gen) c.entry = { at: Date.now(), value };
      return value;
    })
    .catch((error) => {
      log("wallet_error", error.message);
      return emptyBalances(walletAddress, error.message);
    })
    .finally(() => { if (c.inflight === p) c.inflight = null; });
  if (!fresh) c.inflight = p;
  return p.then((v) => structuredClone(v));
}

/**
 * Read on-chain token balance directly via RPC (confirmed commitment).
 * Returns { raw: bigint, decimals: number, ui: string }.
 * Uses `confirmed` commitment to see the latest state after a tx lands.
 */
export async function getOnchainTokenBalance(mint) {
  const connection = getConnection();
  const wallet = getWallet();
  const mintPk = new PublicKey(mint);

  try {
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: mintPk }, { commitment: "confirmed" });
    if (!accounts.value?.length) return { raw: 0n, decimals: 0, ui: "0" };
    let totalRaw = 0n;
    let decimals = 9;
    for (const { account } of accounts.value) {
      const info = account?.data?.parsed?.info;
      const amt = info?.tokenAmount;
      if (!info?.mint || amt?.amount == null || !/^\d+$/.test(String(amt.amount))) continue;
      totalRaw += BigInt(amt.amount);
      if (decimals === 9 && Number.isInteger(amt.decimals)) decimals = amt.decimals;
    }
    const ui = decimals === 0 ? totalRaw.toString() : (Number(totalRaw / 10n ** BigInt(decimals))).toFixed(decimals).replace(/\.?0+$/, "");
    return { raw: totalRaw, decimals, ui };
  } catch (e) {
    // Throw instead of reporting 0: callers diff balances, and a fake 0 either
    // hides a withdrawal or makes existing tokens look like a fresh one.
    log("wallet_error", `getOnchainTokenBalance ${mint}: ${e.message}`);
    throw e;
  }
}

/**
 * Fetch USD price for a mint from Jupiter price API v3.
 */
export async function getTokenUsdPrice(mint) {
  try {
    const normalized = normalizeMint(mint);
    const res = await fetch(`${JUPITER_PRICE_API}?ids=${normalized}`, {
      headers: { "x-api-key": getJupiterApiKey() },
    });
    if (!res.ok) return null;
    const body = await res.json();
    const price = Number(body?.[normalized]?.usdPrice);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  if (
    mint === "SOL" ||
    mint === "native" ||
    /^So1+$/.test(mint) ||
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
export async function swapToken({
  input_mint,
  output_mint,
  amount,
}, options = {}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals;
      // A guessed 9 on a 6-decimal token asks Jupiter for 1000x the amount.
      if (!Number.isInteger(decimals)) throw new Error(`Could not read decimals for ${input_mint}`);
    }
    // Exact string → raw conversion; float math can round past the real balance.
    const amountStr = typeof amount === "string" && /^\d+(\.\d+)?$/.test(amount.trim())
      ? uiToRawAmount(amount, decimals).toString()
      : Math.floor(Number(amount) * Math.pow(10, decimals)).toString();

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });

    // Price impact cap: "agent" (default 5%) or "close" (configurable, default 25%)
    const impactCap = options.impactCap === "close"
      ? Number(config.management.maxCloseSwapPriceImpactPct ?? 25)
      : Number(config.management.maxSwapPriceImpactPct ?? 5);
    if (impactCap > 0) {
      search.set("maxPriceImpactBps", String(Math.round(impactCap * 100)));
    }

    const referralParams = getJupiterReferralParams();
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const orderRes = await fetch(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    // Invalidate wallet balance cache after successful swap
    invalidateWalletBalances();

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}

/** UI decimal string (e.g. "1.234") → raw integer (bigint) using the given decimals. */
export function uiToRawAmount(uiString, decimals) {
  const dec = Number(decimals);
  if (!Number.isInteger(dec) || dec < 0) throw new Error(`Invalid decimals: ${decimals}`);
  const s = String(uiString).trim();
  if (!s) throw new Error("Empty amount string");
  const [intPart = "0", fracPart = ""] = s.split(".");
  const frac = (fracPart + "0".repeat(dec)).slice(0, dec);
  return BigInt(intPart) * 10n ** BigInt(dec) + BigInt(frac);
}