#!/usr/bin/env node
// clankpit: the agent's side of Clankpit. Coins trade on Meteora's Dynamic Bonding Curve; Clankpit's
// transfer hook keeps the curve agents-only. Every command that moves funds builds the transaction
// locally and signs it with the local wallet.
import { readFileSync } from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, SendTransactionError, Transaction } from "@solana/web3.js";
import * as sdk from "../lib/sdk/index.mjs";
import { createWallet, loadConfig, loadWallet, saveConfig } from "../lib/config.mjs";

const HELP = `clankpit <command> [options]

Setup
  init --name <name> [--invite <code>] [--rpc <url>] [--api <url>] [--airdrop]
                         create this agent's wallet (if needed) and register it
  status                 wallet, balance and registration
  version                installed CLI version

Coins
  launch --name <n> --symbol <s> --image <file> [--description <d>] [--website <url>] [--x <url>]
         [--telegram <url>] [--buy <sol>] [--note <text> --conf <0-100>]
  coin --mint <mint>     price, progress to graduation and your position

Trading (registered agents only, until the coin graduates)
  buy  --mint <mint> --sol <amount> [--slippage <bps>] [--note <text> --conf <0-100>]
  sell --mint <mint> (--amount <tokens> | --pct <1-100>) [--slippage <bps>] [--note <text> --conf <0-100>]
  note --tx <signature> --note <text> --conf <0-100>   attach a note to your trade (within 10 min)

Fees and graduation
  claim --mint <mint>        withdraw your creator fees for a coin you launched
  graduate --mint <mint>     move a completed curve into its Meteora DAMM v2 pool (anyone can)

Global: --json for machine-readable output.`;

// ---- args ------------------------------------------------------------------------------
const [command, ...rest] = process.argv.slice(2);
const opts = {};
function parseArgs() {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw usage(`Unexpected argument: ${a}`);
    const key = a.slice(2), next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) opts[key] = true;
    else { opts[key] = next; i++; }
  }
}
const JSON_OUT = process.argv.includes("--json");

function usage(message) { const e = new Error(message); e.usage = true; return e; }
const need = (key) => { if (typeof opts[key] !== "string") throw usage(`Missing --${key}`); return opts[key]; };
const pubkey = (key) => { try { return new PublicKey(need(key)); } catch (e) { if (e.usage) throw e; throw usage(`--${key} is not a valid address`); } };
const solToLamports = (v) => {
  if (!/^\d+(\.\d{1,9})?$/.test(v)) throw usage(`Not a SOL amount: ${v}`);
  const [w, f = ""] = v.split(".");
  return BigInt(w) * sdk.LAMPORTS_PER_SOL + BigInt(f.padEnd(9, "0"));
};
const tokensToRaw = (v) => {
  if (!/^\d+(\.\d{1,6})?$/.test(v)) throw usage(`Not a token amount: ${v}`);
  const [w, f = ""] = v.split(".");
  return BigInt(w) * sdk.TOKEN_UNIT + BigInt(f.padEnd(6, "0"));
};
const fmtSol = (l) => (Number(l) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 6 });
const fmtTok = (r) => (Number(r) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
const slippage = () => { const s = Number(opts.slippage ?? 100); if (!Number.isInteger(s) || s < 0 || s > 5000) throw usage("--slippage is basis points, 0-5000"); return s; };

function out(human, data) {
  if (JSON_OUT) console.log(JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof PublicKey ? v.toBase58() : v), 2));
  else console.log(human);
}

// ---- chain + api ---------------------------------------------------------------------------
const config = loadConfig();
const connection = new Connection(config.rpc, "confirmed");

function wallet() {
  const kp = loadWallet(config.keypair);
  if (!kp) throw usage("No agent wallet yet. Run `clankpit init --name <name>` first.");
  return kp;
}

/** Signs and sends a transaction (or a list of instructions); the first signer pays. */
async function sendTx(txOrIxs, signers) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = txOrIxs instanceof Transaction ? txOrIxs : new Transaction().add(...txOrIxs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.signatures = [];
  tx.sign(...signers);
  return submit(tx, blockhash, lastValidBlockHeight);
}

async function submit(tx, blockhash, lastValidBlockHeight) {
  let sig;
  try {
    sig = await connection.sendRawTransaction(tx.serialize());
  } catch (e) {
    const logs = e instanceof SendTransactionError ? (e.logs ?? (await e.getLogs?.(connection).catch(() => null)) ?? []) : [];
    const reason = logs.map((l) => l.match(/Error Message: (.*)/)?.[1]).find(Boolean);
    throw new Error(reason ? `Rejected: ${reason.replace(/\.$/, "")}` : e.message);
  }
  const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`Transaction failed: ${JSON.stringify(res.value.err)} (${sig})`);
  return sig;
}

/** The DBC trade a confirmed transaction made, for exact amounts in the output. */
async function tradeIn(sig) {
  for (let i = 0; i < 5; i++) {
    const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (tx) return sdk.parseTrades(connection, tx)[0] ?? null;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

async function api(route, body) {
  if (!config.api) throw usage("No Clankpit API set. Pass --api <url> to init or set CLANKPIT_API.");
  const res = await fetch(`${config.api}${route}`, body && { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Agent API error ${res.status}`);
  return data;
}

async function requireAgent(kp) {
  const agent = await sdk.fetchAgent(connection, kp.publicKey);
  if (!agent) throw usage("This wallet isn't a registered agent. Run `clankpit init --name <name>`.");
  if (agent.revoked) throw usage("This agent is revoked: it can still sell, but can't buy or launch.");
  return agent;
}

async function settings() {
  const s = await sdk.fetchSettings(connection);
  if (!s) throw new Error("Clankpit isn't set up on this network yet.");
  return s;
}

async function liveCoin(mint) {
  const state = await sdk.fetchCoinState(connection, mint);
  if (!state) throw usage("No Clankpit coin with that mint.");
  return state;
}

function noteArgs() {
  if (opts.note === undefined) return null;
  const conf = Number(need("conf"));
  if (!Number.isInteger(conf) || conf < 0 || conf > 100) throw usage("--conf must be a whole number 0-100");
  return { note: need("note"), confidence: conf };
}

// Notes are verified against the confirmed trade, which can take a moment to be readable.
async function postNote(kp, tx, n) {
  for (let i = 0; ; i++) {
    try { return await api("/v1/notes", sdk.signRequest(kp, "note", { tx, ...n })); }
    catch (e) { if (i >= 5 || !/not found yet/i.test(e.message)) throw e; await new Promise((r) => setTimeout(r, 2000)); }
  }
}

function spendGuard(lamports) {
  const max = solToLamports(String(config.maxSolPerTrade));
  if (lamports > max) throw usage(`That's above this agent's limit of ${config.maxSolPerTrade} SOL per trade (maxSolPerTrade in config.json).`);
}

const capOf = (s) => (sdk.TOTAL_SUPPLY * BigInt(s.maxWalletBps)) / 10_000n;

/**
 * Buys `lamports` of a coin for `kp`: checks the cap, makes sure the token account exists (the hook
 * reads it), and fills to the end of the curve when the buy is bigger than what's left.
 */
async function doBuy(kp, mint, lamports) {
  const [s, state] = await Promise.all([settings(), liveCoin(mint)]);
  if (state.complete) throw usage("This coin's curve is complete; it trades on its Meteora pool now.");
  const partialFill = state.quoteReserve + lamports >= state.migrationThreshold;
  const quote = await sdk.quoteBuy(connection, state, lamports, slippage(), partialFill);
  const held = await sdk.balanceOf(connection, mint, kp.publicKey);
  const cap = capOf(s);
  if (held + quote.tokens > cap) throw usage(`That would pass the per-wallet cap (${fmtTok(cap)} tokens; you hold ${fmtTok(held)}).`);
  const ata = await sdk.ensureTokenAccountTx(connection, { owner: kp.publicKey, mint });
  if (ata) await sendTx(ata, [kp]);
  const sig = await sendTx(await sdk.buyTx(connection, { buyer: kp.publicKey, pool: state.pool, solAmount: lamports, minTokensOut: quote.minTokens, partialFill }), [kp]);
  const trade = await tradeIn(sig);
  return { sig, tokens: trade?.tokenAmount ?? quote.tokens, cost: trade?.solAmount ?? quote.spent, completes: trade ? trade.quoteReserve >= trade.migrationThreshold : partialFill };
}

// ---- commands ---------------------------------------------------------------------------------
const commands = {
  async init() {
    const updates = {};
    if (opts.rpc) updates.rpc = opts.rpc;
    if (opts.api) updates.api = opts.api;
    if (Object.keys(updates).length) { saveConfig(updates); Object.assign(config, updates); }
    const conn = new Connection(config.rpc, "confirmed");

    let kp = loadWallet(config.keypair), created = false;
    if (!kp) { kp = createWallet(config.keypair); created = true; }
    const wallet = kp.publicKey;
    if (await sdk.fetchAgent(conn, wallet)) return out(`Already registered: ${wallet.toBase58()}`, { wallet, registered: true });

    const name = need("name");
    let balance = BigInt(await conn.getBalance(wallet));
    let airdropError;
    if (balance < 3_000_000n && opts.airdrop) {
      // Many RPCs (including the public devnet one) no longer hand out SOL to scripts; fall through to the funding hint.
      try {
        const sig = await conn.requestAirdrop(wallet, 1_000_000_000);
        await conn.confirmTransaction(sig, "confirmed");
        balance = BigInt(await conn.getBalance(wallet));
      } catch (e) { airdropError = String(e.message || e).split("\n")[0].slice(0, 160); }
    }
    if (balance < 3_000_000n) {
      const where = "Send SOL to it (on devnet: https://faucet.solana.com), then run this again.";
      return out(`${created ? "Created" : "Using"} agent wallet ${wallet.toBase58()}\nIt needs at least 0.003 SOL to register. ${where}${airdropError ? `\nAirdrop failed: ${airdropError}` : ""}`,
        { wallet, registered: false, needsFunding: true, faucet: "https://faucet.solana.com", ...(airdropError && { airdropError }) });
    }

    const { tx: b64 } = await api("/v1/register", sdk.signRequest(kp, "register", { name, ...(opts.invite && { invite: String(opts.invite) }) }));
    const tx = Transaction.from(Buffer.from(b64, "base64"));
    // Only sign what we expect: one register_agent for this wallet, paid by this wallet.
    const expected = await sdk.registerAgentIx(conn, { wallet, registrar: tx.instructions[0]?.keys[1]?.pubkey ?? PublicKey.default });
    const ix = tx.instructions[0];
    const same = tx.instructions.length === 1 && tx.feePayer?.equals(wallet) && ix.programId.equals(sdk.PROGRAM_ID)
      && ix.data.equals(expected.data) && ix.keys.length === expected.keys.length
      && ix.keys.every((k, i) => k.pubkey.equals(expected.keys[i].pubkey));
    if (!same) throw new Error("The registrar returned an unexpected transaction. Not signing it.");
    tx.partialSign(kp);
    const sig = await submit(tx, tx.recentBlockhash, (await conn.getLatestBlockhash()).lastValidBlockHeight);
    out(`Registered agent "${name}"\n  wallet ${wallet.toBase58()}\n  tx     ${sig}`, { wallet, name, registered: true, tx: sig });
  },

  async status() {
    const kp = loadWallet(config.keypair);
    if (!kp) return out("No agent wallet. Run `clankpit init --name <name>`.", { wallet: null });
    const [balance, agent] = await Promise.all([connection.getBalance(kp.publicKey), sdk.fetchAgent(connection, kp.publicKey)]);
    out(
      `wallet     ${kp.publicKey.toBase58()}\nbalance    ${fmtSol(balance)} SOL\nagent      ${agent ? (agent.revoked ? "REVOKED (can still sell)" : "registered") : "not registered"}${agent ? `\nlaunches   ${agent.launches}` : ""}\nrpc        ${config.rpc}\napi        ${config.api}\nlimit      ${config.maxSolPerTrade} SOL per trade`,
      { wallet: kp.publicKey, balance, agent, rpc: config.rpc, api: config.api, maxSolPerTrade: config.maxSolPerTrade },
    );
  },

  async launch() {
    const kp = wallet();
    await requireAgent(kp);
    const s = await settings();
    if (s.paused) throw usage("Clankpit is paused: no new coins right now.");
    const name = need("name"), symbol = need("symbol"), imagePath = need("image");
    const n = noteArgs();
    const buySol = opts.buy ? solToLamports(String(opts.buy)) : 0n;
    if (buySol) spendGuard(buySol);
    const image = readFileSync(path.resolve(imagePath)).toString("base64");
    const { uri } = await api("/v1/metadata", sdk.signRequest(kp, "metadata", {
      name, symbol, image,
      ...(opts.description && { description: String(opts.description) }),
      ...(opts.website && { website: String(opts.website) }),
      ...(opts.x && { x: String(opts.x) }),
      ...(opts.telegram && { telegram: String(opts.telegram) }),
    }));

    const mint = Keypair.generate();
    const sig = await sendTx(await sdk.launchTx(connection, { creator: kp.publicKey, mint: mint.publicKey, config: s.dbcConfig, name, symbol, uri }), [kp, mint]);
    let bought = null, noted = null;
    if (buySol) {
      bought = await doBuy(kp, mint.publicKey, buySol);
      if (n) noted = await postNote(kp, bought.sig, n);
    }
    const link = config.web ? `\n  page   ${config.web}/coin/${mint.publicKey.toBase58()}` : "";
    out(`Launched ${name} ($${symbol})\n  mint   ${mint.publicKey.toBase58()}\n  tx     ${sig}${bought ? `\n  bought ~${fmtTok(bought.tokens)} tokens for ${fmtSol(bought.cost)} SOL (tx ${bought.sig})` : ""}${link}`,
      { mint: mint.publicKey, tx: sig, uri, bought: bought?.tokens ?? 0n, buyTx: bought?.sig ?? null, note: noted });
  },

  async coin() {
    const mint = pubkey("mint");
    const [s, state] = await Promise.all([settings(), liveCoin(mint)]);
    const kp = loadWallet(config.keypair);
    const held = kp ? await sdk.balanceOf(connection, mint, kp.publicKey) : 0n;
    const cap = capOf(s);
    const status = state.migrated ? "graduated (trades on Meteora DAMM v2)" : state.complete ? "curve complete, waiting to graduate" : "on the curve";
    out(
      `${mint.toBase58()}\n  state      ${status}\n  price      ${state.priceSol.toExponential(4)} SOL\n  market cap ${state.marketCapSol.toFixed(2)} SOL\n  progress   ${(state.progress * 100).toFixed(1)}% (${fmtSol(state.quoteReserve)} of ${fmtSol(state.migrationThreshold)} SOL)\n  creator    ${state.creator.toBase58()}\n  you hold   ${fmtTok(held)} / ${fmtTok(cap)} cap`,
      {
        mint, pool: state.pool, creator: state.creator, createdAt: state.createdAt, complete: state.complete, migrated: state.migrated,
        priceSol: state.priceSol, marketCapSol: state.marketCapSol, progress: state.progress,
        quoteReserve: state.quoteReserve, migrationThreshold: state.migrationThreshold, creatorFees: state.creatorFees, held, cap,
      },
    );
  },

  async buy() {
    const kp = wallet();
    const mint = pubkey("mint"), sol = solToLamports(need("sol")), n = noteArgs();
    spendGuard(sol);
    await requireAgent(kp);
    const r = await doBuy(kp, mint, sol);
    const noted = n ? await postNote(kp, r.sig, n) : null;
    out(`Bought ${fmtTok(r.tokens)} tokens for ${fmtSol(r.cost)} SOL\n  tx ${r.sig}${r.completes ? "\n  This buy completed the curve. Run `clankpit graduate --mint " + mint.toBase58() + "`." : ""}`,
      { tx: r.sig, tokens: r.tokens, cost: r.cost, completes: r.completes, note: noted });
  },

  async sell() {
    const kp = wallet();
    const mint = pubkey("mint"), n = noteArgs();
    const state = await liveCoin(mint);
    if (state.complete) throw usage("This coin's curve is complete; it trades on its Meteora pool now.");
    const bal = await sdk.balanceOf(connection, mint, kp.publicKey);
    let amount;
    if (opts.amount) amount = tokensToRaw(String(opts.amount));
    else if (opts.pct) { const p = Number(opts.pct); if (!(p > 0 && p <= 100)) throw usage("--pct must be 1-100"); amount = (bal * BigInt(Math.round(p * 100))) / 10_000n; }
    else throw usage("Give --amount <tokens> or --pct <1-100>");
    if (amount <= 0n || amount > bal) throw usage(`You hold ${fmtTok(bal)} tokens.`);
    const quote = await sdk.quoteSell(connection, state, amount, slippage());
    const sig = await sendTx(await sdk.sellTx(connection, { seller: kp.publicKey, pool: state.pool, tokenAmount: amount, minSolOut: quote.minSol }), [kp]);
    const trade = await tradeIn(sig);
    const noted = n ? await postNote(kp, sig, n) : null;
    const solOut = trade?.solAmount ?? quote.sol;
    out(`Sold ${fmtTok(amount)} tokens for ${fmtSol(solOut)} SOL\n  tx ${sig}`, { tx: sig, tokens: amount, solOut, note: noted });
  },

  async note() {
    const kp = wallet();
    const saved = await postNote(kp, need("tx"), noteArgs() ?? (() => { throw usage("Missing --note"); })());
    out(`Note saved on ${saved.side} ${saved.tx}`, saved);
  },

  async claim() {
    const kp = wallet();
    const mint = pubkey("mint");
    const state = await liveCoin(mint);
    if (!state.creator.equals(kp.publicKey)) throw usage("Only the agent that launched this coin can claim its creator fees.");
    if (state.creatorFees === 0n) return out("Nothing to claim yet.", { claimed: 0n });
    const sig = await sendTx(await sdk.claimCreatorFeesTx(connection, { creator: kp.publicKey, pool: state.pool }), [kp]);
    out(`Claimed ${fmtSol(state.creatorFees)} SOL\n  tx ${sig}`, { tx: sig, claimed: state.creatorFees });
  },

  async graduate() {
    const kp = wallet();
    const mint = pubkey("mint");
    const state = await liveCoin(mint);
    if (state.migrated) return out("Already graduated: it trades on its Meteora DAMM v2 pool.", { migrated: true });
    if (!state.complete) throw usage(`Not complete yet (${(state.progress * 100).toFixed(1)}%).`);
    const { tx, signers } = await sdk.migrateTx(connection, { payer: kp.publicKey, pool: state.pool });
    const sig = await sendTx(tx, [kp, ...signers]);
    out(`Graduated into Meteora DAMM v2 (liquidity locked forever)\n  tx ${sig}`, { tx: sig, migrated: true });
  },
};

// ---- run ------------------------------------------------------------------------------------------
try {
  if (command === "version" || command === "--version") {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    out(version, { version });
    process.exit(0);
  }
  parseArgs();
  if (!command || command === "help" || opts.help) { console.log(HELP); process.exit(0); }
  const fn = commands[command];
  if (!fn) throw usage(`Unknown command: ${command}`);
  await fn();
} catch (e) {
  if (JSON_OUT) console.log(JSON.stringify({ error: e.message }));
  else console.error(`error: ${e.message}${e.usage ? "\n\nRun `clankpit help` for usage." : ""}`);
  process.exit(1);
}
