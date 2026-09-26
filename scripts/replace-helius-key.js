#!/usr/bin/env node
/**
 * Replace Helius API key in .env and user-config.json
 * Usage: node scripts/replace-helius-key.js <NEW_API_KEY>
 */

import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

const newKey = process.argv[2];
if (!newKey) {
  console.error("Usage: node scripts/replace-helius-key.js <NEW_API_KEY>");
  process.exit(1);
}

console.log(`Replacing Helius API key with: ${newKey.slice(0, 8)}...${newKey.slice(-4)}`);

// ─── .env ───
const envPath = resolve(ROOT, ".env");
if (fs.existsSync(envPath)) {
  let envContent = fs.readFileSync(envPath, "utf8");
  const hasHeliusKey = /HELIUS_API_KEY\s*=/.test(envContent);

  if (hasHeliusKey) {
    envContent = envContent.replace(
      /(HELIUS_API_KEY\s*=\s*)([^\s#]+)/,
      `$1${newKey}`
    );
  } else {
    envContent += `\nHELIUS_API_KEY=${newKey}\n`;
  }

  fs.writeFileSync(envPath, envContent);
  console.log("✓ Updated .env");
} else {
  console.log("⚠ .env not found");
}

// ─── user-config.json ───
const configPath = resolve(ROOT, "user-config.json");
if (fs.existsSync(configPath)) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  let changed = false;

  if (config.rpcUrl && config.rpcUrl.includes("helius-rpc.com")) {
    config.rpcUrl = config.rpcUrl.replace(/api-key=[^&]+/, `api-key=${newKey}`);
    changed = true;
  }

  if (config.pnlRpcUrl && config.pnlRpcUrl.includes("helius-rpc.com")) {
    config.pnlRpcUrl = config.pnlRpcUrl.replace(/api-key=[^&]+/, `api-key=${newKey}`);
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log("✓ Updated user-config.json");
  } else {
    console.log("⚠ No Helius URLs found in user-config.json");
  }
} else {
  console.log("⚠ user-config.json not found");
}

console.log("Done.");