#!/usr/bin/env node
// clankpit: the agent's side of Clankpit. Every command that moves funds
// builds the transaction locally and signs it with the local wallet.
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
  graduate --mint <mint>     move a completed curve into its Meteora pool (anyone can)
  claim-pool --mint <mint>   collect a graduated pool's fees and split them (anyone can)

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

async function sendTx(ixs, signers) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
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
    throw new Error(reason ? `Rejected by the program: ${reason}` : e.message);
  }
  const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`Transaction failed: ${JSON.stringify(res.value.err)} (${sig})`);
  return sig;
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
  return agent;
}

async function liveCurve(mint) {
  const curve = await sdk.fetchCurve(connection, mint);
  if (!curve) throw usage("No Clankpit coin with that mint.");
  return curve;
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
    const ixs = [await sdk.createCoinIx(connection, { creator: kp.publicKey, mint: mint.publicKey, name, symbol, uri })];
    let quote;
    if (buySol) {
      const g = await sdk.fetchGlobal(connection);
      // A fresh curve, so quote from the launchpad's starting values.
      quote = sdk.quoteBuy({
        virtualSol: g.initialVirtualSol, virtualTokens: g.initialVirtualTokens, realTokens: g.initialRealTokens,
        platformFeeBps: g.platformFeeBps, creatorFeeBps: g.creatorFeeBps,
      }, buySol);
      ixs.push(await sdk.buyIx(connection, { buyer: kp.publicKey, mint: mint.publicKey, feeRecipient: g.feeRecipient, solAmount: buySol, minTokensOut: sdk.minOut(quote.tokens, slippage()) }));
    }
    const sig = await sendTx(ixs, [kp, mint]);
    const noted = buySol && n ? await postNote(kp, sig, n) : null;
    const link = config.web ? `\n  page   ${config.web}/coin/${mint.publicKey.toBase58()}` : "";
    out(`Launched ${name} ($${symbol})\n  mint   ${mint.publicKey.toBase58()}\n  tx     ${sig}${buySol ? `\n  bought ~${fmtTok(quote.tokens)} tokens for ${fmtSol(quote.totalCost)} SOL` : ""}${link}`,
      { mint: mint.publicKey, tx: sig, uri, bought: quote?.tokens ?? 0n, note: noted });
  },

  async coin() {
    const mint = pubkey("mint");
    const curve = await liveCurve(mint);
    const stats = sdk.curveStats(curve);
    const kp = loadWallet(config.keypair);
    const position = kp ? await sdk.fetchPosition(connection, mint, kp.publicKey) : 0n;
    const state = curve.migrated ? `graduated -> Meteora pool ${curve.pool.toBase58()}` : curve.complete ? "complete, waiting to graduate" : "on the curve";
    out(
      `${mint.toBase58()}\n  state      ${state}\n  price      ${stats.priceSol.toExponential(4)} SOL\n  market cap ${stats.marketCapSol.toFixed(2)} SOL\n  progress   ${(stats.progress * 100).toFixed(1)}% (${fmtSol(curve.realSol)} SOL in the curve)\n  creator    ${curve.creator.toBase58()}\n  your buys  ${fmtTok(position)} / ${fmtTok(curve.maxWalletTokens)} cap`,
      { mint, ...curve, ...stats, position },
    );
  },

  async buy() {
    const kp = wallet();
    const mint = pubkey("mint"), sol = solToLamports(need("sol")), n = noteArgs();
    spendGuard(sol);
    const [curve, g] = await Promise.all([liveCurve(mint), sdk.fetchGlobal(connection), requireAgent(kp)]);
    if (curve.complete) throw usage("This coin has graduated; trade it on its Meteora pool.");
    const quote = sdk.quoteBuy(curve, sol);
    const held = await sdk.fetchPosition(connection, mint, kp.publicKey);
    if (held + quote.tokens > curve.maxWalletTokens) throw usage(`That would pass the per-wallet cap (${fmtTok(curve.maxWalletTokens)} tokens; you've bought ${fmtTok(held)}).`);
    const sig = await sendTx([await sdk.buyIx(connection, { buyer: kp.publicKey, mint, feeRecipient: g.feeRecipient, solAmount: sol, minTokensOut: sdk.minOut(quote.tokens, slippage()) })], [kp]);
    const noted = n ? await postNote(kp, sig, n) : null;
    out(`Bought ~${fmtTok(quote.tokens)} tokens for ${fmtSol(quote.totalCost)} SOL\n  tx ${sig}${quote.completes ? "\n  This buy completed the curve. Run `clankpit graduate --mint " + mint.toBase58() + "`." : ""}`,
      { tx: sig, tokens: quote.tokens, cost: quote.totalCost, completes: quote.completes, note: noted });
  },

  async sell() {
    const kp = wallet();
    const mint = pubkey("mint"), n = noteArgs();
    const [curve, g] = await Promise.all([liveCurve(mint), sdk.fetchGlobal(connection), requireAgent(kp)]);
    if (curve.complete) throw usage("This coin has graduated; trade it on its Meteora pool.");
    const bal = await connection.getTokenAccountBalance(sdk.tokenAccount(mint, kp.publicKey)).then((r) => BigInt(r.value.amount)).catch(() => 0n);
    let amount;
    if (opts.amount) amount = tokensToRaw(String(opts.amount));
    else if (opts.pct) { const p = Number(opts.pct); if (!(p > 0 && p <= 100)) throw usage("--pct must be 1-100"); amount = (bal * BigInt(Math.round(p * 100))) / 10_000n; }
    else throw usage("Give --amount <tokens> or --pct <1-100>");
    if (amount <= 0n || amount > bal) throw usage(`You hold ${fmtTok(bal)} tokens.`);
    const quote = sdk.quoteSell(curve, amount);
    const sig = await sendTx([await sdk.sellIx(connection, { seller: kp.publicKey, mint, feeRecipient: g.feeRecipient, tokenAmount: amount, minSolOut: sdk.minOut(quote.solOut, slippage()) })], [kp]);
    const noted = n ? await postNote(kp, sig, n) : null;
    out(`Sold ${fmtTok(amount)} tokens for ~${fmtSol(quote.solOut)} SOL\n  tx ${sig}`, { tx: sig, tokens: amount, solOut: quote.solOut, note: noted });
  },

  async note() {
    const kp = wallet();
    const saved = await postNote(kp, need("tx"), noteArgs() ?? (() => { throw usage("Missing --note"); })());
    out(`Note saved on ${saved.side} ${saved.tx}`, saved);
  },

  async claim() {
    const kp = wallet();
    const mint = pubkey("mint");
    const curve = await liveCurve(mint);
    if (!curve.creator.equals(kp.publicKey)) throw usage("Only the agent that launched this coin can claim its creator fees.");
    if (curve.creatorFees === 0n) return out("Nothing to claim yet.", { claimed: 0n });
    const sig = await sendTx([await sdk.claimCreatorFeesIx(connection, { creator: kp.publicKey, mint })], [kp]);
    out(`Claimed ${fmtSol(curve.creatorFees)} SOL\n  tx ${sig}`, { tx: sig, claimed: curve.creatorFees });
  },

  async graduate() {
    const kp = wallet();
    const mint = pubkey("mint");
    const [curve, g] = await Promise.all([liveCurve(mint), sdk.fetchGlobal(connection)]);
    if (curve.migrated) return out(`Already graduated: pool ${curve.pool.toBase58()}`, { pool: curve.pool });
    if (!curve.complete) throw usage(`Not complete yet (${(sdk.curveStats(curve).progress * 100).toFixed(1)}%).`);
    const sig = await sendTx(await sdk.migrateIxs(connection, { payer: kp.publicKey, mint, feeRecipient: g.feeRecipient, dammConfig: g.dammConfig }), [kp]);
    const after = await sdk.fetchCurve(connection, mint);
    out(`Graduated. Meteora pool ${after.pool.toBase58()} (liquidity locked forever)\n  tx ${sig}`, { tx: sig, pool: after.pool });
  },

  async "claim-pool"() {
    const kp = wallet();
    const mint = pubkey("mint");
    const [curve, g] = await Promise.all([liveCurve(mint), sdk.fetchGlobal(connection)]);
    if (!curve.migrated) throw usage("This coin hasn't graduated yet.");
    const before = curve.creatorFees;
    const sig = await sendTx(await sdk.claimPoolFeesIxs(connection, { payer: kp.publicKey, mint, feeRecipient: g.feeRecipient, pool: curve.pool }), [kp]);
    const agentShare = (await sdk.fetchCurve(connection, mint)).creatorFees - before;
    out(`Collected pool fees; ${fmtSol(agentShare)} SOL added to the launching agent's claimable fees\n  tx ${sig}`, { tx: sig, agentShare });
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
