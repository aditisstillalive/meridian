import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./lessons.js";
import { repoPath } from "./repo-root.js";
import { escapeHtml } from "./telegram.js";
import { config } from "./config.js";
import { getWallet } from "./tools/wallet.js";

const STATE_FILE = repoPath("state.json");
const LESSONS_FILE = repoPath("lessons.json");

export async function generateBriefing() {
  const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [] };
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Positions Activity
  const allPositions = Object.values(state.positions || {});
  const openedLast24h = allPositions.filter(p => new Date(p.deployed_at) > last24h);
  const closedLast24h = allPositions.filter(p => p.closed && new Date(p.closed_at) > last24h);

  // 2. Performance Activity (from performance log)
  const perfLast24h = (lessonsData.performance || []).filter(p => new Date(p.recorded_at) > last24h);
  const totalPnLUsd = perfLast24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const totalFeesUsd = perfLast24h.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);

  // 3. Lessons Learned
  const lessonsLast24h = (lessonsData.lessons || []).filter(l => new Date(l.created_at) > last24h);

  // 4. Current State
  const openPositions = allPositions.filter(p => !p.closed);
  const perfSummary = getPerformanceSummary();
  const meteoraTotal = await fetchMeteoraAllTimePnl();
  const solMode = Boolean(config.management.solMode);

  let allTimeLine = "";
  if (meteoraTotal) {
    const value = solMode ? meteoraTotal.pnlSol : meteoraTotal.pnlUsd;
    const winPart = perfSummary ? `, ${perfSummary.win_rate_pct}% win since ${perfSince(lessonsData)}` : "";
    allTimeLine = `📊 All-time PnL: ${formatSigned(value, solMode ? "◎" : "$", solMode ? 4 : 2)} (${meteoraTotal.closed} closed${winPart})`;
  } else if (perfSummary) {
    // Meteora unreachable — local log only covers positions since it started
    allTimeLine = `📊 PnL since ${perfSince(lessonsData)}: $${perfSummary.total_pnl_usd.toFixed(2)} (${perfSummary.win_rate_pct}% win, local log)`;
  }

  // 5. Format Message
  const lines = [
    "☀️ <b>Morning Briefing</b> (Last 24h)",
    "────────────────",
    `<b>Activity:</b>`,
    `📥 Positions Opened: ${openedLast24h.length}`,
    `📤 Positions Closed: ${closedLast24h.length}`,
    "",
    `<b>Performance:</b>`,
    `💰 Net PnL: ${totalPnLUsd >= 0 ? "+" : ""}$${totalPnLUsd.toFixed(2)}`,
    `💎 Fees Earned: $${totalFeesUsd.toFixed(2)}`,
    perfLast24h.length > 0
      ? `📈 Win Rate (24h): ${Math.round((perfLast24h.filter(p => p.pnl_usd > 0).length / perfLast24h.length) * 100)}%`
      : "📈 Win Rate (24h): N/A",
    "",
    `<b>Lessons Learned:</b>`,
    lessonsLast24h.length > 0
      ? lessonsLast24h.map(l => `• ${escapeHtml(l.rule)}`).join("\n")
      : "• No new lessons recorded overnight.",
    "",
    `<b>Current Portfolio:</b>`,
    `📂 Open Positions: ${openPositions.length}`,
    allTimeLine,
    "────────────────"
  ];

  return lines.join("\n");
}

// Wallet-wide all-time PnL as shown on the Meteora dashboard (local lessons.json
// only covers closes recorded since the performance log started).
async function fetchMeteoraAllTimePnl() {
  try {
    const user = getWallet().publicKey.toString();
    const res = await fetch(`https://dlmm.datapi.meteora.ag/portfolio/total?user=${user}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const pnlUsd = Number(data.totalPnlUsd);
    const pnlSol = Number(data.totalPnlSol);
    if (!Number.isFinite(pnlUsd)) throw new Error("missing totalPnlUsd");
    return { pnlUsd, pnlSol, closed: data.totalClosedPositions ?? "?" };
  } catch (err) {
    log("briefing_warn", `Meteora all-time PnL fetch failed: ${err.message}`);
    return null;
  }
}

function perfSince(lessonsData) {
  const first = (lessonsData.performance || []).map(p => p.recorded_at).filter(Boolean).sort()[0];
  return first ? first.slice(0, 10) : "?";
}

function formatSigned(value, unit, digits) {
  if (!Number.isFinite(value)) return "?";
  return `${value >= 0 ? "+" : "-"}${unit}${Math.abs(value).toFixed(digits)}`;
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}
