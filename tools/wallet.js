import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";
import { instrumentConnection, countRpc } from "./rpc-stats.js";
import { getTokensInfo } from "./jup-tokens.js";
import {
  sendAndConfirmSigned,
  basePriorityPrice,
  cappedPriorityPrice,
  buildSenderTipIx,
} from "./tx-send.js";

let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) {
    _connection = new Connection(process.env.RPC_URL, "confirmed");
    instrumentConnection(_connection);
  }
  return _connection;
}

function getWallet() {
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

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
export async function getWalletBalances() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    log("wallet_error", "HELIUS_API_KEY not set in .env");
    return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Helius API key missing" };
  }

  try {
    const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const balances = data.balances || [];

    // ─── Find SOL and USDC ────────────────────────────────────
    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;

    // ─── Map all tokens ───────────────────────────────────────
    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error) {
    log("wallet_error", error.message);
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: error.message,
    };
  }
}

/**
 * On-chain balance of one mint for the wallet, read straight from RPC at
 * `confirmed` (not the Helius indexed balances API, which lags behind txs that
 * just confirmed). Sums every token account the owner holds for the mint. The
 * `mint` filter makes the RPC resolve the mint's own program, so Token and
 * Token-2022 accounts are both covered.
 *
 * Returns { raw: bigint, decimals: number|null, accounts }. decimals is null
 * only when the owner has no account for the mint (raw is then 0n). Throws when
 * the read fails or an account is unparseable, so callers can treat the balance
 * as unknown instead of zero.
 *
 * @param {string} mint
 * @param {object} [deps] Test seam only: { connection, owner }.
 */
export async function getOnchainTokenBalance(mint, deps = {}) {
  const connection = deps.connection ?? getConnection();
  const owner = deps.owner ?? getWallet().publicKey;
  const res = await connection.getParsedTokenAccountsByOwner(
    owner,
    { mint: new PublicKey(mint) },
    { commitment: "confirmed" },
  );
  if (!res || !Array.isArray(res.value)) throw new Error(`getParsedTokenAccountsByOwner returned no value for ${mint}`);
  let raw = 0n;
  let decimals = null;
  for (const { account } of res.value) {
    const amt = account?.data?.parsed?.info?.tokenAmount;
    if (amt?.amount == null || !/^\d+$/.test(String(amt.amount))) {
      throw new Error(`Unparseable token account for ${mint}`);
    }
    raw += BigInt(amt.amount);
    if (decimals == null && Number.isInteger(amt.decimals)) decimals = amt.decimals;
  }
  return { raw, decimals, accounts: res.value.length };
}

/**
 * Get token USD price from Jupiter Price API V3.
 * Returns price in USD or null if not available.
 */
export async function getTokenUsdPrice(mint) {
  try {
    const url = `${JUPITER_PRICE_API}?ids=${encodeURIComponent(mint)}&vsToken=${encodeURIComponent(config.tokens.USDC)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const price = data?.data?.[mint]?.price;
    return price != null ? Number(price) : null;
  } catch {
    return null;
  }
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Normalize any SOL-like address to the correct wrapped SOL mint
// Re-export for dlmm.js and close-swap.js
export { getTokensInfo } from "./jup-tokens.js";
export { instrumentConnection, countRpc } from "./rpc-stats.js";
export { sendAndConfirmSigned, basePriorityPrice, cappedPriorityPrice, buildSenderTipIx } from "./tx-send.js";

export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
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

export const DEFAULT_MAX_SWAP_PRICE_IMPACT_PCT = 5;
export const DEFAULT_MAX_CLOSE_SWAP_PRICE_IMPACT_PCT = 25;

/**
 * Price impact of a Swap v2 /order response, in percent (0.12 = 0.12%).
 * Prefers `priceImpact` (number, already percent); falls back to the deprecated
 * `priceImpactPct` (string decimal fraction, e.g. "-0.0012") × 100.
 */
export function parsePriceImpactPercent(order) {
  const direct = order?.priceImpact;
  if (direct != null && direct !== "" && Number.isFinite(Number(direct))) return Number(direct);
  const frac = order?.priceImpactPct;
  if (frac != null && frac !== "" && Number.isFinite(Number(frac))) return Number(frac) * 100;
  return null;
}

const IMPACT_CAPS = {
  default: { key: "maxSwapPriceImpactPct", fallback: DEFAULT_MAX_SWAP_PRICE_IMPACT_PCT },
  close: { key: "maxCloseSwapPriceImpactPct", fallback: DEFAULT_MAX_CLOSE_SWAP_PRICE_IMPACT_PCT },
};

/** Effective cap for `kind` from config.risk, or its default when unset/invalid. */
export function priceImpactCap(kind = "default") {
  const c = IMPACT_CAPS[kind] ?? IMPACT_CAPS.default;
  const v = Number(config.risk?.[c.key]);
  return { key: c.key, cap: Number.isFinite(v) && v > 0 ? v : c.fallback };
}

/**
 * Refusal result when |impactPct| exceeds the cap of `kind`, else null. An
 * unknown impact (null) is allowed — the field is undocumented on Swap v2, and
 * blocking every swap if Jupiter dropped it would strand exits.
 */
export function checkPriceImpact(impactPct, { input_mint, output_mint, kind = "default" } = {}) {
  const { key, cap } = priceImpactCap(kind);
  if (impactPct == null) return null;
  const abs = Math.abs(impactPct);
  if (abs <= cap) return null;
  const error = `Swap refused: price impact ${abs.toFixed(2)}% exceeds ${key} ${cap}%`;
  log("swap", `${error} (${input_mint} → ${output_mint})`);
  return {
    success: false,
    price_impact_refused: true,
    price_impact_pct: Math.round(abs * 100) / 100,
    max_price_impact_pct: cap,
    price_impact_cap_key: key,
    input_mint,
    output_mint,
    error,
  };
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}, opts = {}) {
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
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
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

    // Nothing signed yet — refuse on excessive price impact before building the tx.
    const impact = parsePriceImpactPercent(order);
    const impactRefusal = checkPriceImpact(impact, { input_mint, output_mint, kind: opts.impactCap });
    if (impactRefusal) return impactRefusal;

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