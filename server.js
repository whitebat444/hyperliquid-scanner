"use strict";
const express = require("express");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json({ type: ["application/json", "application/*+json"], limit: "64kb" }));
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("X-Robots-Tag", "noindex, nofollow");
  next();
});
const PORT = process.env.PORT || 3000;
const HL_API = "https://api.hyperliquid.xyz/info";
const VERSION = "1.1.0";
const RADAR = ["BTC","ETH","SOL","HYPE","ZEC","PUMP","LIT","ENA","UNI","PONS","NEAR","AERO","AVAX","TAO"];
// Configure the public account address in Railway, not in repository source.
const WALLET = process.env.HL_WALLET || "";
const READ_TYPES = new Set(["metaAndAssetCtxs", "clearinghouseState", "frontendOpenOrders"]);
const num = value => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const bool = value => typeof value === "boolean" ? value : null;

async function hyperliquid(body) {
  if (!READ_TYPES.has(body.type)) throw new Error("Unsupported read-only request");
  const response = await fetch(HL_API, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
  return response.json();
}

function contexts(payload) {
  if (!Array.isArray(payload) || !Array.isArray(payload[0]?.universe) ||
      !Array.isArray(payload[1]) || payload[0].universe.length !== payload[1].length) {
    throw new Error("Invalid Hyperliquid market response");
  }
  return new Map(payload[0].universe.map((asset, i) => [asset.name, payload[1][i]]));
}

function symbolsInput(value) {
  if (value === undefined) return RADAR;
  if (!Array.isArray(value) || value.length < 1 || value.length > 64 ||
      value.some(s => typeof s !== "string" || !/^[A-Za-z0-9:._-]{1,40}$/.test(s))) {
    throw new Error("symbols must contain 1-64 valid market names");
  }
  return [...new Set(value.map(s => s.toUpperCase()))];
}

async function marketData(symbols = RADAR, payload) {
  const wanted = symbolsInput(symbols);
  const ctxMap = contexts(payload || await hyperliquid({ type: "metaAndAssetCtxs" }));
  const markets = {};
  for (const name of wanted) {
    const ctx = ctxMap.get(name);
    if (!ctx) continue;
    const mark = num(ctx.markPx), oi = num(ctx.openInterest), funding = num(ctx.funding);
    markets[name] = {
      mark, mid_price: num(ctx.midPx), funding,
      funding_pct: funding == null ? null : funding * 100,
      funding_interval_hours: 1,
      open_interest_units: oi,
      open_interest_usd: oi == null || mark == null ? null : oi * mark,
      volume_24h_usd: num(ctx.dayNtlVlm), oracle_price: num(ctx.oraclePx),
      previous_day_price: num(ctx.prevDayPx)
    };
  }
  return { source: "Hyperliquid Mainnet", timestamp: new Date().toISOString(),
    data_scope: "default perpetual DEX", markets,
    unavailable_symbols: wanted.filter(s => !ctxMap.has(s)) };
}

async function portfolioData(payload) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(WALLET)) throw new Error("HL_WALLET is not configured correctly");
  const started = new Date().toISOString();
  const [state, orders, meta] = await Promise.all([
    hyperliquid({ type: "clearinghouseState", user: WALLET }),
    hyperliquid({ type: "frontendOpenOrders", user: WALLET }),
    payload || hyperliquid({ type: "metaAndAssetCtxs" })
  ]);
  if (!state || !Array.isArray(state.assetPositions) || !Array.isArray(orders)) {
    throw new Error("Invalid Hyperliquid account/order response; state is unverified");
  }
  const ctxMap = contexts(meta);
  const positions = state.assetPositions.map(x => x.position).map(p => {
    if (!p || num(p.szi) == null) throw new Error("Invalid position size");
    const size = num(p.szi), ctx = ctxMap.get(p.coin);
    return {
      coin: p.coin, side: size > 0 ? "LONG" : "SHORT", size: Math.abs(size),
      entry_price: num(p.entryPx), mark_price: num(ctx?.markPx),
      mid_price: num(ctx?.midPx), oracle_price: num(ctx?.oraclePx),
      position_value: num(p.positionValue), unrealized_pnl: num(p.unrealizedPnl),
      liquidation_price: num(p.liquidationPx), leverage: p.leverage || null,
      margin_used: num(p.marginUsed), return_on_equity: num(p.returnOnEquity),
      cumulative_funding: p.cumFunding || null
    };
  }).filter(p => p.size !== 0);
  const open_orders = orders.map(o => ({
    coin: o.coin, side: o.side, size: num(o.sz), original_size: num(o.origSz),
    price: num(o.limitPx), limit_price: num(o.limitPx),
    order_type: o.orderType || null,
    trigger_condition: o.triggerCondition || null, trigger_price: num(o.triggerPx),
    reduce_only: bool(o.reduceOnly), is_trigger: bool(o.isTrigger),
    is_position_tpsl: bool(o.isPositionTpsl),
    order_id: o.oid, order_timestamp_ms: o.timestamp ?? null,
    time_in_force: o.tif || null,
    // Preserve contingent child orders; do not count these as independent live orders.
    children: Array.isArray(o.children) ? o.children : []
  }));
  const warnings = positions.filter(p => p.mark_price == null).map(p => `Mark unavailable: ${p.coin}`);
  return {
    source: "Hyperliquid Mainnet", timestamp: new Date().toISOString(),
    request_started_at: started, snapshot_id: randomUUID(), cached: false,
    server_version: VERSION, wallet: WALLET,
    data_scope: "configured wallet, default perpetual DEX only; excludes spot, subaccounts and other DEXs",
    exchange_state_time_ms: state.time ?? null,
    account_value: num(state.marginSummary?.accountValue),
    account_value_scope: "perpetual marginSummary; not total wallet net worth",
    withdrawable: num(state.withdrawable), positions, open_orders, warnings
  };
}

async function snapshotData(symbols) {
  const started = new Date().toISOString();
  const meta = await hyperliquid({ type: "metaAndAssetCtxs" });
  const [portfolio, market] = await Promise.all([portfolioData(meta), marketData(symbols, meta)]);
  return { snapshot_id: randomUUID(), server_version: VERSION, cached: false,
    request_started_at: started, timestamp: new Date().toISOString(), portfolio, market };
}

app.get("/", (req, res) => res.json({ service: "Hyperliquid Scanner MCP", version: VERSION,
  status: "online", endpoints: ["/market", "/portfolio", "/snapshot", "/mcp"],
  timestamp: new Date().toISOString() }));

function route(fn) {
  return async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) { res.status(502).json({ error: e.message, live_state_verified: false,
      timestamp: new Date().toISOString() }); }
  };
}
app.get("/market", route(req => marketData(req.query.symbol ? String(req.query.symbol).split(",") : RADAR)));
app.get("/portfolio", route(() => portfolioData()));
app.get("/snapshot", route(() => snapshotData(RADAR)));

const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const symbolSchema = { type: "object", properties: { symbols: { type: "array", minItems: 1,
  maxItems: 64, items: { type: "string" }, description: "Market names; omit for the configured radar." } },
  additionalProperties: false };
const tools = [
  { name: "get_hyperliquid_market", title: "Get Hyperliquid live market data",
    description: "Fetch current mainnet mark and midpoint prices, hourly funding, OI and 24h volume. A snapshot does not establish historical OI changes or chart structure.",
    inputSchema: symbolSchema, annotations },
  { name: "get_hyperliquid_portfolio", title: "Get live Hyperliquid positions and orders",
    description: "Read the configured wallet's current perpetual positions and open orders directly from Hyperliquid. Includes true mark prices, entry, size, PnL, liquidation, stop triggers and is_position_tpsl. Never infer fills from market prices. A zero-size position-wide TP/SL is not automatically invalid. No trading or withdrawal capability.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations },
  { name: "get_hyperliquid_snapshot", title: "Get live portfolio and radar snapshot",
    description: "Fetch the live portfolio, open/trigger orders and radar market data together. Preferred first call for a position scan. Verify timestamp and data_scope; do not substitute old screenshots on failure. Uses only read-only info API calls.",
    inputSchema: symbolSchema, annotations }
];
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

app.all("/mcp", async (req, res) => {
  if (req.method !== "POST") return res.set("Allow", "POST").status(405).end();
  const msg = req.body;
  if (!msg || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return res.status(400).json(rpcError(null, -32600, "Invalid JSON-RPC request"));
  }
  if (msg.id == null) return res.status(202).end();
  const id = msg.id;
  if (msg.method === "initialize") {
    const requested = msg.params?.protocolVersion;
    const protocolVersion = ["2025-03-26", "2025-06-18"].includes(requested) ? requested : "2025-06-18";
    return res.json(rpcResult(id, { protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: "hyperliquid-scanner", version: VERSION },
      instructions: "Read-only. Use get_hyperliquid_snapshot for account-aware scans; verify freshness, scope, true marks and position-wide TP/SL flags. Errors mean unknown, never an empty portfolio. Never claim orders were executed by this server." }));
  }
  if (msg.method === "ping") return res.json(rpcResult(id, {}));
  if (msg.method === "tools/list") return res.json(rpcResult(id, { tools }));
  if (msg.method !== "tools/call") return res.json(rpcError(id, -32601, "Method not found"));
  const name = msg.params?.name, args = msg.params?.arguments ?? {};
  if (!tools.some(t => t.name === name)) return res.json(rpcError(id, -32601, "Unknown tool"));
  try {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid arguments");
    const allowed = name === "get_hyperliquid_portfolio" ? [] : ["symbols"];
    if (Object.keys(args).some(k => !allowed.includes(k))) throw new Error("Unexpected argument");
    const data = name === "get_hyperliquid_portfolio" ? await portfolioData() :
      name === "get_hyperliquid_snapshot" ? await snapshotData(symbolsInput(args.symbols)) :
      await marketData(symbolsInput(args.symbols));
    return res.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data, isError: false }));
  } catch (e) {
    return res.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify({
      error: e.message, live_state_verified: false, timestamp: new Date().toISOString() }) }], isError: true }));
  }
});
app.listen(PORT, "0.0.0.0", () => console.log(`Hyperliquid Scanner MCP v${VERSION} listening on ${PORT}`));
