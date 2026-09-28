/**
 * Swap Guard — protects agent swap_token calls from selling tokens that
 * belong to a recent position close.
 *
 * A close may leave "exposure" (unsold base token delta) when:
 * - The pre-close balance was unknown (can't compute delta)
 * - The withdrawal never showed on-chain
 * - The swap failed after retries
 * - The swap was ambiguous (may still land)
 * - Price impact exceeded the close-swap cap (25%)
 *
 * The exposure is recorded in state.json via recordCloseExposure().
 * This module checks that exposure before allowing an agent swap_token
 * to sell the same mint.
 *
 * Rules:
 * - If no exposure for the mint within CLOSE_EXPOSURE_WINDOW_MS: allow.
 * - If exposure exists but its ambiguous_until is in the future: block with retry hint.
 * - If exposure exists and unambiguous: allow selling up to the remaining
 *   unsold_raw (exposure.unsold_raw - exposure.agent_sold_raw).
 * - If the agent tries to sell more than remaining: clamp and warn.
 */

import { findRecentCloseExposure, noteAgentExposureSwap } from "../state.js";

const CLOSE_EXPOSURE_WINDOW_MS = 2 * 60 * 60 * 1000; // 2h (matches state.js)

/**
 * @param {{ input_mint: string, amount: string|number }} args
 * @returns {Promise<{ allow: boolean, clampedAmount?: string, reason?: string, exposure?: object, retryAfterMs?: number }>}
 */
export async function checkSwapGuard(args) {
  const { input_mint, amount } = args;
  if (!input_mint) return { allow: true };

  // Only guard SOL-bound swaps (base -> SOL). Other swaps are not our concern.
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (input_mint === SOL_MINT) return { allow: true };

  const exposure = findRecentCloseExposure(input_mint, { windowMs: CLOSE_EXPOSURE_WINDOW_MS });
  if (!exposure) return { allow: true };

  // Exposure exists — check ambiguous window
  const now = Date.now();
  const ambiguousUntil = exposure.ambiguous_until ? Date.parse(exposure.ambiguous_until) : 0;
  if (ambiguousUntil && now < ambiguousUntil) {
    const retryAfterMs = ambiguousUntil - now;
    return {
      allow: false,
      reason: `Close exposure for ${input_mint} is still ambiguous (swap may land). Wait ${Math.ceil(retryAfterMs / 1000)}s before retry.`,
      exposure,
      retryAfterMs,
    };
  }

  // Exposure is unambiguous — compute remaining unsold delta the agent may sell
  const unsoldRaw = BigInt(exposure.unsold_raw || "0");
  const agentSoldRaw = BigInt(exposure.agent_sold_raw || "0");
  const remainingRaw = unsoldRaw > agentSoldRaw ? unsoldRaw - agentSoldRaw : 0n;

  // Parse requested amount (UI string -> raw bigint using decimals)
  let requestedRaw = 0n;
  if (typeof amount === "string") {
    const dec = exposure.decimals ?? 0;
    if (dec > 0) {
      // amount like "123.456" -> raw bigint
      const parts = amount.split(".");
      const intPart = parts[0] || "0";
      const fracPart = (parts[1] || "").padEnd(dec, "0").slice(0, dec);
      requestedRaw = BigInt(intPart + fracPart);
    } else {
      requestedRaw = BigInt(amount);
    }
  } else if (typeof amount === "number") {
    // amount as number (not recommended, but handle)
    const dec = exposure.decimals ?? 0;
    requestedRaw = BigInt(Math.round(amount * 10 ** dec));
  }

  if (requestedRaw <= 0n) return { allow: true };

  if (remainingRaw === 0n) {
    return {
      allow: false,
      reason: `Close exposure for ${input_mint} fully resolved (no unsold delta remaining).`,
      exposure,
    };
  }

  if (requestedRaw > remainingRaw) {
    // Clamp to remaining
    const dec = exposure.decimals ?? 0;
    let clampedUi;
    if (dec > 0) {
      const s = remainingRaw.toString().padStart(dec + 1, "0");
      const intPart = s.slice(0, s.length - dec);
      const frac = s.slice(s.length - dec).replace(/0+$/, "");
      clampedUi = frac ? `${intPart}.${frac}` : intPart;
    } else {
      clampedUi = remainingRaw.toString();
    }
    return {
      allow: true,
      clampedAmount: clampedUi,
      reason: `Close exposure for ${input_mint}: clamping sell from ${amount} to ${clampedUi} (remaining unsold delta).`,
      exposure,
    };
  }

  return { allow: true, exposure };
}

/**
 * Call after a successful swap_token that was guarded.
 * @param {{ input_mint: string, amount: string|number, tx: string }} result
 */
export async function recordSwapGuardResult(result) {
  const { input_mint, amount, tx } = result;
  if (!input_mint || !tx) return;

  const exposure = findRecentCloseExposure(input_mint, { windowMs: CLOSE_EXPOSURE_WINDOW_MS });
  if (!exposure) return;

  // Parse amount sold to raw
  let soldRaw = 0n;
  if (typeof amount === "string") {
    const dec = exposure.decimals ?? 0;
    if (dec > 0) {
      const parts = amount.split(".");
      const intPart = parts[0] || "0";
      const fracPart = (parts[1] || "").padEnd(dec, "0").slice(0, dec);
      soldRaw = BigInt(intPart + fracPart);
    } else {
      soldRaw = BigInt(amount);
    }
  } else if (typeof amount === "number") {
    const dec = exposure.decimals ?? 0;
    soldRaw = BigInt(Math.round(amount * 10 ** dec));
  }

  if (soldRaw > 0n) {
    noteAgentExposureSwap(exposure.position, { soldRaw });
  }
}