// @clankpit/sdk: everything a client needs for Clankpit. Coins live on Meteora's Dynamic Bonding Curve
// (DBC) with the Clankpit program as their Token-2022 transfer hook; this module builds the DBC and
// Clankpit instructions, reads coin state and decodes trades, plus the signed-request format the agent
// API accepts. Amounts are bigints: lamports for SOL, raw units (6 decimals) for tokens.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import anchor from "@coral-xyz/anchor";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DynamicBondingCurveClient,
  MigrationFeeOption,
  MigrationOption,
  SwapMode,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurve,
  deriveDammV2PoolAddress,
  deriveDbcPoolAddress,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";

const { AnchorProvider, BN, BorshCoder, EventParser, Program } = anchor;
export const IDL = createRequire(import.meta.url)("./idl/clankpit.json");
export const PROGRAM_ID = new PublicKey(IDL.address);

export const DECIMALS = 6;
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const TOKEN_UNIT = 1_000_000n;
export const TOTAL_SUPPLY = 1_000_000_000n * TOKEN_UNIT;
export const DBC_PROGRAM_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const DBC_POOL_AUTHORITY = new PublicKey("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
export const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
/** DAMM v2 config DBC graduates 0.25%-fee pools into (MigrationFeeOption.FixedBps25). */
export const DAMM_V2_CONFIG_25BPS = new PublicKey("7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd");

// ---- addresses ----------------------------------------------------------------
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const b = (s) => Buffer.from(s);

export const settingsPda = () => pda(b("settings"));
export const agentPda = (wallet) => pda(b("agent"), wallet.toBuffer());
export const coinPda = (mint) => pda(b("coin"), mint.toBuffer());
export const extraMetasPda = (mint) => pda(b("extra-account-metas"), mint.toBuffer());
export const tokenAccount = (mint, owner) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
/** A coin's DBC pool under the Clankpit config. */
export const poolAddress = (config, mint) => deriveDbcPoolAddress(NATIVE_MINT, mint, config);
/** The DAMM v2 pool a coin graduates into. */
export const dammPoolAddress = (mint, dammConfig = DAMM_V2_CONFIG_25BPS) => deriveDammV2PoolAddress(dammConfig, mint, NATIVE_MINT);

// ---- clients -------------------------------------------------------------------
const READONLY_WALLET = {
  publicKey: PublicKey.default,
  signTransaction: async () => { throw new Error("read-only"); },
  signAllTransactions: async () => { throw new Error("read-only"); },
};
const programs = new WeakMap();
const dbcClients = new WeakMap();
/** Anchor client for the Clankpit program; only used to build instructions and decode accounts. */
export function program(connection) {
  if (!programs.has(connection)) programs.set(connection, new Program(IDL, new AnchorProvider(connection, READONLY_WALLET, {})));
  return programs.get(connection);
}
/** Meteora's DBC client over the same connection. */
export function dbc(connection) {
  if (!dbcClients.has(connection)) dbcClients.set(connection, new DynamicBondingCurveClient(connection, "confirmed"));
  return dbcClients.get(connection);
}

const big = (x) => BigInt(x.toString());
const bn = (x) => new BN(x.toString());

// ---- the Clankpit DBC config ---------------------------------------------------------
/**
 * Curve and fee settings for the Clankpit DBC config: 1B supply (6 decimals), a 1% curve fee split
 * 50/50 between the launching agent and the platform after Meteora's protocol share, graduation at
 * `migrationQuoteThreshold` SOL into a 0.25% DAMM v2 pool whose liquidity is permanently locked,
 * half for the platform and half for the creator, so pool fees split the same way.
 */
export function dbcConfigParameters({ migrationQuoteThreshold = 85, percentageSupplyOnMigration = 20.69 } = {}) {
  return buildCurve({
    token: {
      tokenType: TokenType.Token2022,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: 9,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 50,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps25,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 50,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration,
    migrationQuoteThreshold,
  });
}

/** Creates the Clankpit DBC config (signed by `config` and `payer`). `feeClaimer` receives the platform's fees. */
export function createDbcConfigTx(connection, { config, feeClaimer, leftoverReceiver, payer, parameters = dbcConfigParameters() }) {
  return dbc(connection).partner.createConfigWithTransferHook({
    ...parameters,
    config,
    feeClaimer,
    leftoverReceiver,
    quoteMint: NATIVE_MINT,
    payer,
    transferHookProgram: PROGRAM_ID,
  });
}

// ---- accounts ---------------------------------------------------------------------------
export async function fetchSettings(connection) {
  const s = await program(connection).account.settings.fetchNullable(settingsPda());
  return s && { admin: s.admin, registrar: s.registrar, dbcConfig: s.dbcConfig, maxWalletBps: s.maxWalletBps, paused: s.paused };
}

export async function fetchAgent(connection, wallet) {
  const a = await program(connection).account.agent.fetchNullable(agentPda(wallet));
  return a && { wallet: a.wallet, registeredAt: Number(a.registeredAt), revoked: a.revoked, launches: a.launches };
}

/** The Clankpit record of a coin (who launched it, its pool), or null. */
export async function fetchCoin(connection, mint) {
  const c = await program(connection).account.coin.fetchNullable(coinPda(mint));
  return c && { mint: c.mint, pool: c.pool, creator: c.creator, createdAt: Number(c.createdAt) };
}

/** SOL per token from a DBC sqrt price (Q64.64, raw units). */
export function priceFromSqrt(sqrtPrice) {
  const s = Number(big(sqrtPrice)) / 2 ** 64;
  return s * s * 10 ** (DECIMALS - 9);
}

/**
 * Everything about a coin: its Clankpit record, DBC pool and config, and derived stats.
 * Returns null when the mint isn't a Clankpit coin.
 */
export async function fetchCoinState(connection, mint) {
  const coin = await fetchCoin(connection, mint);
  if (!coin) return null;
  const { pool, config } = await dbc(connection).state.getPoolAndConfig(coin.pool);
  const p = pool.poolState;
  const quoteReserve = big(p.quoteReserve), threshold = big(config.migrationQuoteThreshold);
  const priceSol = priceFromSqrt(p.sqrtPrice);
  return {
    ...coin,
    config: p.config,
    baseReserve: big(p.baseReserve),
    quoteReserve,
    migrationThreshold: threshold,
    progress: threshold > 0n ? Math.min(1, Number(quoteReserve) / Number(threshold)) : 0,
    complete: p.isMigrated === 1 || quoteReserve >= threshold,
    migrated: p.isMigrated === 1,
    priceSol,
    marketCapSol: priceSol * Number(TOTAL_SUPPLY / TOKEN_UNIT),
    creatorFees: big(p.creatorQuoteFee),
    poolState: p,
    poolConfig: config,
    dbcPool: pool,
  };
}

/** The wallet's raw token balance of a coin (0 when it has no token account). */
export async function balanceOf(connection, mint, owner) {
  const info = await connection.getTokenAccountBalance(tokenAccount(mint, owner)).catch(() => null);
  return info ? BigInt(info.value.amount) : 0n;
}

// ---- quotes ------------------------------------------------------------------------------
async function currentPoint(connection, state) {
  if (state.poolConfig.activationType === ActivationType.Slot) return new BN(await connection.getSlot());
  return new BN(Math.floor(Date.now() / 1000));
}

function quote(connection, state, swapBaseForQuote, amountIn, point, slippageBps, swapMode = SwapMode.ExactIn) {
  const q = dbc(connection).pool.swapQuote2({
    virtualPool: state.dbcPool,
    config: state.poolConfig,
    swapBaseForQuote,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint: point,
    swapMode,
    amountIn: bn(amountIn),
    slippageBps,
  });
  const r = q.swapResult ?? q;
  return { out: big(r.outputAmount ?? q.outputAmount), minOut: big(q.minimumAmountOut), fee: big(r.tradingFee ?? 0), spent: r.includedFeeInputAmount != null ? big(r.includedFeeInputAmount) : big(amountIn) };
}

/**
 * Tokens out for `lamports` in (fees included), and the slippage-protected minimum. With `partialFill`, a
 * buy bigger than what is left on the curve fills to the end; `spent` is what it would actually cost.
 */
export async function quoteBuy(connection, state, lamports, slippageBps = 100, partialFill = false) {
  const q = quote(connection, state, false, lamports, await currentPoint(connection, state), slippageBps, partialFill ? SwapMode.PartialFill : SwapMode.ExactIn);
  return { tokens: q.out, minTokens: q.minOut, fee: q.fee, spent: q.spent };
}

/** Lamports out for `tokens` in (fees taken), and the slippage-protected minimum. */
export async function quoteSell(connection, state, tokens, slippageBps = 100) {
  const q = quote(connection, state, true, tokens, await currentPoint(connection, state), slippageBps);
  return { sol: q.out, minSol: q.minOut, fee: q.fee };
}

// ---- instructions ---------------------------------------------------------------------------
export function initializeIx(connection, { admin, registrar, dbcConfig, maxWalletBps = 100 }) {
  const programData = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
  return program(connection).methods.initialize({ registrar, dbcConfig, maxWalletBps })
    .accountsStrict({ admin, settings: settingsPda(), program: PROGRAM_ID, programData, systemProgram: SystemProgram.programId })
    .instruction();
}

export function updateSettingsIx(connection, { admin, registrar, dbcConfig, maxWalletBps, paused }) {
  return program(connection).methods.updateSettings({ registrar, dbcConfig, maxWalletBps }, paused)
    .accountsStrict({ admin, settings: settingsPda() })
    .instruction();
}

export function registerAgentIx(connection, { wallet, registrar }) {
  return program(connection).methods.registerAgent()
    .accountsStrict({ wallet, registrar, settings: settingsPda(), agent: agentPda(wallet), systemProgram: SystemProgram.programId })
    .instruction();
}

export function setAgentStatusIx(connection, { authority, wallet, revoked }) {
  return program(connection).methods.setAgentStatus(revoked)
    .accountsStrict({ authority, settings: settingsPda(), agent: agentPda(wallet) })
    .instruction();
}

export function registerCoinIx(connection, { creator, mint, pool }) {
  return program(connection).methods.registerCoin()
    .accountsStrict({
      creator, settings: settingsPda(), agent: agentPda(creator), mint, pool,
      extraAccountMetaList: extraMetasPda(mint), coin: coinPda(mint),
      tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/**
 * One transaction that creates the coin's DBC pool (mint, metadata, vaults) and registers it with
 * Clankpit, which turns on the agents-only hook. Signed by `creator` and the `mint` keypair.
 */
export async function launchTx(connection, { creator, mint, config, name, symbol, uri }) {
  const tx = await dbc(connection).creator.createPoolWithTransferHook({
    name, symbol, uri, payer: creator, poolCreator: creator, config, baseMint: mint, transferHookProgram: PROGRAM_ID,
  });
  tx.add(await registerCoinIx(connection, { creator, mint, pool: poolAddress(config, mint) }));
  return withCompute(tx, 400_000);
}

/**
 * Creates the owner's token account for a coin if it doesn't exist. Run it before an agent's first buy:
 * the hook's extra accounts are resolved from that account's data, so it has to exist when the buy is built.
 */
export async function ensureTokenAccountTx(connection, { owner, mint, payer = owner }) {
  const ata = tokenAccount(mint, owner);
  if (await connection.getAccountInfo(ata)) return null;
  return new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mint, TOKEN_2022_PROGRAM_ID));
}

/** Sets the transaction's compute unit limit, replacing one the DBC SDK may already have added. */
const withCompute = (tx, units) => {
  const isLimit = (ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2;
  tx.instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...tx.instructions.filter((ix) => !isLimit(ix))];
  return tx;
};

/**
 * Buy on the curve: spend `solAmount` lamports (fees included), receive at least `minTokensOut`.
 * With `partialFill`, a buy bigger than what's left on the curve fills up to the end and spends less.
 */
export async function buyTx(connection, { buyer, pool, solAmount, minTokensOut, partialFill = false }) {
  const tx = await dbc(connection).pool.swap2WithTransferHook({
    owner: buyer, pool, swapBaseForQuote: false, referralTokenAccount: null,
    swapMode: partialFill ? SwapMode.PartialFill : SwapMode.ExactIn, amountIn: bn(solAmount), minimumAmountOut: bn(minTokensOut),
  });
  return withCompute(tx, 400_000);
}

/** Sell to the curve: `tokenAmount` raw tokens in, at least `minSolOut` lamports out. */
export async function sellTx(connection, { seller, pool, tokenAmount, minSolOut }) {
  const tx = await dbc(connection).pool.swap2WithTransferHook({
    owner: seller, pool, swapBaseForQuote: true, referralTokenAccount: null,
    swapMode: SwapMode.ExactIn, amountIn: bn(tokenAmount), minimumAmountOut: bn(minSolOut),
  });
  return withCompute(tx, 400_000);
}

/** The launching agent withdraws its share of the curve fees (in SOL). */
export function claimCreatorFeesTx(connection, { creator, pool, receiver = creator }) {
  return dbc(connection).creator.claimCreatorTradingFee2({
    creator, payer: creator, pool, receiver, maxBaseAmount: new BN(0), maxQuoteAmount: new BN("18446744073709551615"),
  });
}

/** Permissionless once the curve is complete: moves the coin into its DAMM v2 pool. Extra signers included. */
export async function migrateTx(connection, { payer, pool, dammConfig = DAMM_V2_CONFIG_25BPS }) {
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await dbc(connection).migration.migrateToDammV2({ payer, pool, dammConfig });
  return { tx: withCompute(transaction, 1_000_000), signers: [firstPositionNftKeypair, secondPositionNftKeypair] };
}

// ---- events -------------------------------------------------------------------------------
const coder = new BorshCoder(IDL);
const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const camelize = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [camel(k), v]));
/** Decoded Clankpit events (agents, coins) from a transaction's log messages, with camelCase fields. */
export function parseEvents(logMessages) {
  return [...new EventParser(PROGRAM_ID, coder).parseLogs(logMessages ?? [])].map((e) => ({ name: e.name, data: camelize(e.data) }));
}

// Anchor emit_cpi!: a self-invoke whose data is sha256("anchor:event")[..8] + the event.
const EVENT_IX_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
let swapDiscriminator;
const accountKeysOf = (tx) => {
  const msg = tx.transaction.message;
  const statics = msg.staticAccountKeys ?? msg.accountKeys;
  const loaded = tx.meta?.loadedAddresses ?? { writable: [], readonly: [] };
  return [...statics, ...loaded.writable, ...loaded.readonly].map((k) => new PublicKey(k));
};
const ixData = (ix) => Buffer.from(typeof ix.data === "string" ? anchor.utils.bytes.bs58.decode(ix.data) : ix.data);
const ixAccounts = (ix) => ix.accountKeyIndexes ?? ix.accounts;

/**
 * Curve trades in a confirmed transaction (`getTransaction` with maxSupportedTransactionVersion: 0),
 * decoded from DBC's swap events. `trader` is the swap's signer; `mint` is the pool's base mint.
 */
export function parseTrades(connection, tx) {
  if (!tx?.meta || tx.meta.err) return [];
  const client = dbc(connection);
  swapDiscriminator ??= Buffer.from(client.program.idl.instructions.find((i) => i.name === "swap2WithTransferHook" || i.name === "swap2_with_transfer_hook").discriminator);
  const keys = accountKeysOf(tx);
  // The swaps themselves give the trader (payer, account 9) and mint (base_mint, account 7), in order.
  const swaps = [];
  const visit = (ix) => {
    if (!keys[ix.programIdIndex]?.equals(DBC_PROGRAM_ID)) return;
    const data = ixData(ix);
    if (data.subarray(0, 8).equals(swapDiscriminator)) {
      const acc = ixAccounts(ix);
      swaps.push({ trader: keys[acc[9]], mint: keys[acc[7]] });
    }
  };
  const inner = tx.meta.innerInstructions ?? [];
  const outer = tx.transaction.message.compiledInstructions ?? tx.transaction.message.instructions;
  outer.forEach((ix, i) => { visit(ix); inner.filter((g) => g.index === i).forEach((g) => g.instructions.forEach(visit)); });

  const trades = [];
  for (const group of inner) {
    for (const ix of group.instructions) {
      if (!keys[ix.programIdIndex]?.equals(DBC_PROGRAM_ID)) continue;
      const data = ixData(ix);
      if (!data.subarray(0, 8).equals(EVENT_IX_TAG)) continue;
      const ev = client.program.coder.events.decode(data.subarray(8).toString("base64"));
      if (!ev || (ev.name !== "evtSwap2WithTransferHook" && ev.name !== "EvtSwap2WithTransferHook")) continue;
      const d = ev.data;
      const swap = swaps[trades.length] ?? {};
      const buy = Number(d.tradeDirection ?? d.trade_direction) === 1;
      const r = d.swapResult ?? d.swap_result;
      const solAmount = buy ? big(r.includedFeeInputAmount ?? r.included_fee_input_amount) : big(r.outputAmount ?? r.output_amount);
      const tokenAmount = buy ? big(r.outputAmount ?? r.output_amount) : big(r.includedFeeInputAmount ?? r.included_fee_input_amount);
      trades.push({
        pool: d.pool,
        config: d.config,
        mint: swap.mint ?? null,
        trader: swap.trader ?? null,
        side: buy ? "buy" : "sell",
        solAmount,
        tokenAmount,
        fee: big(r.tradingFee ?? r.trading_fee), // to the creator and the platform, 50/50
        protocolFee: big(r.protocolFee ?? r.protocol_fee), // Meteora's 20% of the curve fee
        priceSol: priceFromSqrt(r.nextSqrtPrice ?? r.next_sqrt_price),
        quoteReserve: big(d.quoteReserveAmount ?? d.quote_reserve_amount),
        migrationThreshold: big(d.migrationThreshold ?? d.migration_threshold),
        timestamp: Number(d.currentTimestamp ?? d.current_timestamp),
      });
    }
  }
  return trades;
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

export { Keypair, PublicKey, Transaction, NATIVE_MINT, TOKEN_2022_PROGRAM_ID };
