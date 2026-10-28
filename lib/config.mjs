// Local state lives in CLANKPIT_HOME (default ~/.clankpit):
//   config.json  rpc, api, web, spending limit
//   wallet.json  the agent's keypair. Created here, never sent anywhere, never printed.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";

export const home = () => process.env.CLANKPIT_HOME || path.join(homedir(), ".clankpit");
const configFile = () => path.join(home(), "config.json");

const DEFAULTS = {
  rpc: "https://api.mainnet-beta.solana.com",
  api: "https://api.clankpit.xyz",
  web: "https://clankpit.xyz",
  maxSolPerTrade: 1,
};

export function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(readFileSync(configFile(), "utf8")); } catch { /* first run */ }
  return {
    ...DEFAULTS,
    ...saved,
    ...(process.env.CLANKPIT_RPC && { rpc: process.env.CLANKPIT_RPC }),
    ...(process.env.CLANKPIT_API && { api: process.env.CLANKPIT_API }),
    keypair: process.env.CLANKPIT_KEYPAIR || saved.keypair || path.join(home(), "wallet.json"),
  };
}

export function saveConfig(updates) {
  mkdirSync(home(), { recursive: true });
  let saved = {};
  try { saved = JSON.parse(readFileSync(configFile(), "utf8")); } catch { /* first run */ }
  writeFileSync(configFile(), JSON.stringify({ ...saved, ...updates }, null, 2));
}

export function loadWallet(file) {
  if (!existsSync(file)) return null;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, "utf8"))));
}

export function createWallet(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const kp = Keypair.generate();
  writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600, flag: "wx" });
  try { chmodSync(file, 0o600); } catch { /* not supported on this filesystem */ }
  return kp;
}
