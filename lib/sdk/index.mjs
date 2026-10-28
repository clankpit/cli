// @clankpit/sdk: everything a client needs to talk to the Clankpit curve
// program, plus the signed-request format the agent API accepts.
// Amounts are bigints: lamports for SOL, raw units (6 decimals) for tokens.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import nacl from "tweetnacl";

const { AnchorProvider, BN, BorshCoder, EventParser, Program } = anchor;
export const IDL = createRequire(import.meta.url)("./idl/clankpit_curve.json");
export const PROGRAM_ID = new PublicKey(IDL.address);

export const DECIMALS = 6;
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const TOKEN_UNIT = 1_000_000n;
export const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const DAMM_V2_POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");

// ---- addresses ----------------------------------------------------------------
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const dammPda = (...seeds) => PublicKey.findProgramAddressSync(seeds, DAMM_V2_PROGRAM_ID)[0];
const b = (s) => Buffer.from(s);

export const globalPda = () => pda(b("global"));
export const agentPda = (wallet) => pda(b("agent"), wallet.toBuffer());
export const curvePda = (mint) => pda(b("curve"), mint.toBuffer());
export const positionPda = (curve, wallet) => pda(b("position"), curve.toBuffer(), wallet.toBuffer());
export const poolCreatorPda = (mint) => pda(b("pool_creator"), mint.toBuffer());
export const positionNftPda = (mint) => pda(b("position_nft"), mint.toBuffer());
export const dammAuthorityPda = () => pda(b("damm_authority"));
export const tokenAccount = (mint, owner) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);

/** The Meteora pool a coin graduates into: config-bound when a config is set. */
export function poolAddress(mint, dammConfig) {
  const [hi, lo] = Buffer.compare(mint.toBuffer(), NATIVE_MINT.toBuffer()) === 1 ? [mint, NATIVE_MINT] : [NATIVE_MINT, mint];
  return dammConfig && !dammConfig.equals(PublicKey.default)
    ? dammPda(b("pool"), dammConfig.toBuffer(), hi.toBuffer(), lo.toBuffer())
    : dammPda(b("cpool"), hi.toBuffer(), lo.toBuffer());
}

// ---- program client ----------------------------------------------------------
const READONLY_WALLET = {
  publicKey: PublicKey.default,
  signTransaction: async () => { throw new Error("read-only"); },
  signAllTransactions: async () => { throw new Error("read-only"); },
};
const programs = new WeakMap();
/** Anchor client over a connection; only used to build instructions and decode accounts. */
export function program(connection) {
  if (!programs.has(connection)) programs.set(connection, new Program(IDL, new AnchorProvider(connection, READONLY_WALLET, {})));
  return programs.get(connection);
}

const big = (bn) => BigInt(bn.toString());
const bn = (x) => new BN(x.toString());

export async function fetchGlobal(connection) {
  const g = await program(connection).account.global.fetchNullable(globalPda());
  return g && {
    admin: g.admin, registrar: g.registrar, feeRecipient: g.feeRecipient, dammConfig: g.dammConfig,
    platformFeeBps: g.platformFeeBps, creatorFeeBps: g.creatorFeeBps, maxWalletBps: g.maxWalletBps,
    poolFeeCreatorBps: g.poolFeeCreatorBps, paused: g.paused,
    initialVirtualSol: big(g.initialVirtualSol), initialVirtualTokens: big(g.initialVirtualTokens),
    initialRealTokens: big(g.initialRealTokens), totalSupply: big(g.totalSupply),
  };
}

export async function fetchAgent(connection, wallet) {
  const a = await program(connection).account.agent.fetchNullable(agentPda(wallet));
  return a && { wallet: a.wallet, registeredAt: Number(a.registeredAt), revoked: a.revoked, launches: a.launches };
}

export async function fetchCurve(connection, mint) {
  const c = await program(connection).account.curve.fetchNullable(curvePda(mint));
  return c && {
    mint: c.mint, creator: c.creator,
    virtualSol: big(c.virtualSol), virtualTokens: big(c.virtualTokens),
    realSol: big(c.realSol), realTokens: big(c.realTokens), totalSupply: big(c.totalSupply),
    platformFeeBps: c.platformFeeBps, creatorFeeBps: c.creatorFeeBps, maxWalletTokens: big(c.maxWalletTokens),
    creatorFees: big(c.creatorFees), pool: c.pool, createdAt: Number(c.createdAt), complete: c.complete, migrated: c.migrated,
  };
}

export async function fetchPosition(connection, mint, wallet) {
  const p = await program(connection).account.position.fetchNullable(positionPda(curvePda(mint), wallet));
  return p ? big(p.netBought) : 0n;
}

// ---- curve math (mirrors programs/clankpit_curve/src/math.rs) -------------------
const fee = (x, bps) => (x * BigInt(bps)) / 10_000n;

/** What `buy(solAmount)` does: tokens out, SOL actually charged, and whether it graduates the curve. */
export function quoteBuy(curve, solAmount) {
  const { virtualSol: vs, virtualTokens: vt } = curve;
  let platformFee = fee(solAmount, curve.platformFeeBps), creatorFee = fee(solAmount, curve.creatorFeeBps);
  let solIn = solAmount - platformFee - creatorFee;
  let tokens = (vt * solIn) / (vs + solIn);
  if (tokens >= curve.realTokens) {
    tokens = curve.realTokens;
    solIn = (vs * tokens + (vt - tokens) - 1n) / (vt - tokens);
    platformFee = fee(solIn, curve.platformFeeBps);
    creatorFee = fee(solIn, curve.creatorFeeBps);
  }
  return { tokens, solIn, platformFee, creatorFee, totalCost: solIn + platformFee + creatorFee, completes: tokens === curve.realTokens };
}

/** What `sell(tokens)` pays out after fees. */
export function quoteSell(curve, tokens) {
  const gross = (curve.virtualSol * tokens) / (curve.virtualTokens + tokens);
  const platformFee = fee(gross, curve.platformFeeBps), creatorFee = fee(gross, curve.creatorFeeBps);
  return { gross, platformFee, creatorFee, solOut: gross - platformFee - creatorFee };
}

/** Price in SOL per whole token, market cap in SOL, and graduation progress (0..1). */
export function curveStats(curve, initialRealTokens = 793_100_000n * TOKEN_UNIT) {
  const price = Number(curve.virtualSol) / Number(curve.virtualTokens) * Number(TOKEN_UNIT) / Number(LAMPORTS_PER_SOL);
  return {
    priceSol: price,
    marketCapSol: price * Number(curve.totalSupply / TOKEN_UNIT),
    progress: curve.complete ? 1 : Number(initialRealTokens - curve.realTokens) / Number(initialRealTokens),
  };
}

export const minOut = (amount, slippageBps) => (amount * (10_000n - BigInt(slippageBps))) / 10_000n;

// ---- instructions ----------------------------------------------------------------
const common = { systemProgram: SystemProgram.programId, tokenProgram: TOKEN_2022_PROGRAM_ID };

export const registerAgentIx = (connection, { wallet, registrar }) =>
  program(connection).methods.registerAgent()
    .accountsStrict({ wallet, registrar, global: globalPda(), agent: agentPda(wallet), systemProgram: SystemProgram.programId })
    .instruction();

export function createCoinIx(connection, { creator, mint, name, symbol, uri }) {
  const curve = curvePda(mint);
  return program(connection).methods.createCoin(name, symbol, uri).accountsStrict({
    creator, agent: agentPda(creator), global: globalPda(), mint, curve, vault: tokenAccount(mint, curve),
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, ...common,
  }).instruction();
}

export function buyIx(connection, { buyer, mint, feeRecipient, solAmount, minTokensOut }) {
  const curve = curvePda(mint);
  return program(connection).methods.buy(bn(solAmount), bn(minTokensOut)).accountsStrict({
    buyer, agent: agentPda(buyer), global: globalPda(), feeRecipient, mint, curve, vault: tokenAccount(mint, curve),
    buyerTokenAccount: tokenAccount(mint, buyer), position: positionPda(curve, buyer),
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, ...common,
  }).instruction();
}

export function sellIx(connection, { seller, mint, feeRecipient, tokenAmount, minSolOut }) {
  const curve = curvePda(mint);
  return program(connection).methods.sell(bn(tokenAmount), bn(minSolOut)).accountsStrict({
    seller, agent: agentPda(seller), global: globalPda(), feeRecipient, mint, curve, vault: tokenAccount(mint, curve),
    sellerTokenAccount: tokenAccount(mint, seller), position: positionPda(curve, seller), ...common,
  }).instruction();
}

export const claimCreatorFeesIx = (connection, { creator, mint }) =>
  program(connection).methods.claimCreatorFees().accountsStrict({ creator, curve: curvePda(mint) }).instruction();

// `pool` defaults to where migrate will put it; after migration pass curve.pool.
function graduationAccounts({ payer, mint, feeRecipient, dammConfig, pool: knownPool }) {
  const poolCreator = poolCreatorPda(mint), nft = positionNftPda(mint), pool = knownPool ?? poolAddress(mint, dammConfig);
  return {
    payer, global: globalPda(), feeRecipient, mint, curve: curvePda(mint), poolCreator,
    creatorTokenA: tokenAccount(mint, poolCreator), wsolMint: NATIVE_MINT,
    creatorTokenB: getAssociatedTokenAddressSync(NATIVE_MINT, poolCreator, true, TOKEN_PROGRAM_ID),
    pool, position: dammPda(b("position"), nft.toBuffer()),
    positionNftAccount: dammPda(b("position_nft_account"), nft.toBuffer()), positionNftMint: nft,
    tokenAVault: dammPda(b("token_vault"), mint.toBuffer(), pool.toBuffer()),
    tokenBVault: dammPda(b("token_vault"), NATIVE_MINT.toBuffer(), pool.toBuffer()),
    poolAuthority: DAMM_V2_POOL_AUTHORITY, dammEventAuthority: dammPda(b("__event_authority")), dammProgram: DAMM_V2_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, ...common,
  };
}

/** Permissionless graduation into Meteora. Needs a high compute limit. */
export async function migrateIxs(connection, args) {
  const accounts = {
    ...graduationAccounts(args),
    vault: tokenAccount(args.mint, curvePda(args.mint)),
    dammConfig: args.dammConfig ?? PublicKey.default,
    dammAuthority: dammAuthorityPda(),
  };
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
    await program(connection).methods.migrate().accountsStrict(accounts).instruction(),
  ];
}

/** Permissionless: collect the graduated pool's fees and split them agent/platform. */
export async function claimPoolFeesIxs(connection, args) {
  const { positionNftMint: _, ...accounts } = graduationAccounts(args);
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    await program(connection).methods.claimPoolFees().accountsStrict(accounts).instruction(),
  ];
}

// ---- events ------------------------------------------------------------------------
const coder = new BorshCoder(IDL);
const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
/** Decoded program events from a transaction's log messages, with camelCase fields. */
export function parseEvents(logMessages) {
  return [...new EventParser(PROGRAM_ID, coder).parseLogs(logMessages ?? [])].map((e) => ({
    name: e.name,
    data: Object.fromEntries(Object.entries(e.data).map(([k, v]) => [camel(k), v])),
  }));
}

// ---- signed requests to the agent API ------------------------------------------------
// The agent signs: "clankpit-v1\n<action>\n<wallet>\n<ts>\n<sha256 of the canonical JSON body>".
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
  : JSON.stringify(v);
const requestMessage = (action, wallet, ts, body) =>
  Buffer.from(`clankpit-v1\n${action}\n${wallet}\n${ts}\n${createHash("sha256").update(canonical(body)).digest("hex")}`);

export function signRequest(keypair, action, body) {
  const wallet = keypair.publicKey.toBase58(), ts = Date.now();
  const sig = nacl.sign.detached(requestMessage(action, wallet, ts, body), keypair.secretKey);
  return { wallet, ts, sig: Buffer.from(sig).toString("base64"), body };
}

/** Returns the signer's PublicKey, or throws. */
export function verifyRequest(req, action, maxAgeMs = 5 * 60_000) {
  const { wallet, ts, sig, body } = req ?? {};
  if (typeof wallet !== "string" || typeof sig !== "string" || !Number.isFinite(ts) || body === undefined) throw new Error("Malformed signed request.");
  if (Math.abs(Date.now() - ts) > maxAgeMs) throw new Error("Request expired; check your clock.");
  const key = new PublicKey(wallet);
  const ok = nacl.sign.detached.verify(requestMessage(action, wallet, ts, body), Buffer.from(sig, "base64"), key.toBytes());
  if (!ok) throw new Error("Bad signature.");
  return key;
}

export { Keypair, PublicKey };
