const express = require("express");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json({ type: ["application/json", "application/*+json"] }));
const PORT = process.env.PORT || 3000;
const HL_API = "https://api.hyperliquid.xyz/info";
const RADAR = ["BTC","ETH","SOL","HYPE","ZEC","PUMP","LIT","ENA","UNI","PONS","NEAR","AERO","AVAX","TAO"];
const WALLET = process.env.HL_WALLET || "0xD969A2938Bc8691B39b8b53Eaa77765d381b3757";

async function hyperliquid(body) {
  const response = await fetch(HL_API, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
  return response.json();
}

async function marketData(symbols = RADAR) {
  const wanted = new Set(symbols.map(s => String(s).toUpperCase()));
  const result = await hyperliquid({type:"metaAndAssetCtxs"});
  const meta=result[0], ctxs=result[1], markets={};
  for (let i=0;i<meta.universe.length;i++) {
    const asset=meta.universe[i], ctx=ctxs[i];
    if (!wanted.has(asset.name)) continue;
    const mark=Number(ctx.markPx);
    const oi=Number(ctx.openInterest);
    markets[asset.name]={
      mark,
      funding:Number(ctx.funding),
      funding_pct:Number(ctx.funding)*100,
      open_interest_units:oi,
      open_interest_usd:oi*mark,
      volume_24h_usd:Number(ctx.dayNtlVlm),
      oracle_price:Number(ctx.oraclePx),
      previous_day_price:Number(ctx.prevDayPx)
    };
  }
  return {source:"Hyperliquid Mainnet",timestamp:new Date().toISOString(),markets};
}

async function portfolioData() {
  const [state, orders, mids] = await Promise.all([
    hyperliquid({type:"clearinghouseState", user:WALLET}),
    hyperliquid({type:"frontendOpenOrders", user:WALLET}),
    hyperliquid({type:"allMids"})
  ]);

  const positions=(state.assetPositions || []).map(x => x.position).filter(p => Number(p.szi) !== 0).map(p => ({
    coin:p.coin,
    side:Number(p.szi) > 0 ? "LONG" : "SHORT",
    size:Math.abs(Number(p.szi)),
    entry_price:p.entryPx == null ? null : Number(p.entryPx),
    mark_price:mids[p.coin] == null ? null : Number(mids[p.coin]),
    position_value:p.positionValue == null ? null : Number(p.positionValue),
    unrealized_pnl:p.unrealizedPnl == null ? null : Number(p.unrealizedPnl),
    liquidation_price:p.liquidationPx == null ? null : Number(p.liquidationPx),
    leverage:p.leverage || null,
    margin_used:p.marginUsed == null ? null : Number(p.marginUsed)
  }));

  const open_orders=(orders || []).map(o => ({
    coin:o.coin,
    side:o.side,
    size:Number(o.sz),
    price:Number(o.limitPx),
    order_type:o.orderType || null,
    trigger_condition:o.triggerCondition || null,
    trigger_price:o.triggerPx == null ? null : Number(o.triggerPx),
    reduce_only:Boolean(o.reduceOnly),
    order_id:o.oid
  }));

  return {
    source:"Hyperliquid Mainnet",
    timestamp:new Date().toISOString(),
    wallet:WALLET,
    account_value:Number(state.marginSummary?.accountValue || 0),
    withdrawable:Number(state.withdrawable || 0),
    positions,
    open_orders
  };
}

app.get("/", (req,res) => res.json({
  service:"Hyperliquid Scanner MCP",
  status:"online",
  endpoints:["/market","/portfolio","/mcp"],
  timestamp:new Date().toISOString()
}));

app.get("/market", async (req,res) => {
  try {
    const symbols = req.query.symbol ? String(req.query.symbol).split(",") : RADAR;
    res.set("Cache-Control","no-store");
    res.json(await marketData(symbols));
  } catch (e) {
    res.status(500).json({error:e.message,timestamp:new Date().toISOString()});
  }
});

app.get("/portfolio", async (req,res) => {
  try {
    res.set("Cache-Control","no-store");
    res.json(await portfolioData());
  } catch (e) {
    res.status(500).json({error:e.message,timestamp:new Date().toISOString()});
  }
});

const tool = {
  name:"get_hyperliquid_market",
  title:"Get Hyperliquid live market data",
  description:"Read current Hyperliquid mainnet mark price, funding, open interest and 24h volume for one or more supported crypto markets. Use this for live-price and market scans.",
  inputSchema:{
    type:"object",
    properties:{
      symbols:{
        type:"array",
        items:{type:"string"},
        description:"Symbols to fetch, e.g. BTC, ETH, HYPE, ZEC. Omit for the full radar."
      }
    },
    additionalProperties:false
  },
  annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}
};

function rpcResult(id,result){ return {jsonrpc:"2.0",id,result}; }
function rpcError(id,code,message){ return {jsonrpc:"2.0",id,error:{code,message}}; }

app.all("/mcp", async (req,res) => {
  res.set("Cache-Control","no-store");
  if (req.method === "GET") return res.status(405).send("Use MCP Streamable HTTP POST");
  if (req.method !== "POST") return res.status(405).end();

  const msg=req.body || {};
  const id=msg.id ?? null;
  try {
    if (msg.method === "initialize") {
      return res.json(rpcResult(id,{
        protocolVersion:"2025-06-18",
        capabilities:{tools:{}},
        serverInfo:{name:"hyperliquid-scanner",version:"1.0.0"},
        instructions:"Use get_hyperliquid_market for live Hyperliquid mainnet price, funding, open interest and volume. This server is read-only."
      }));
    }
    if (msg.method === "notifications/initialized") return res.status(202).end();
    if (msg.method === "ping") return res.json(rpcResult(id,{}));
    if (msg.method === "tools/list") return res.json(rpcResult(id,{tools:[tool]}));
    if (msg.method === "tools/call") {
      if (msg.params?.name !== tool.name) return res.json(rpcError(id,-32601,"Unknown tool"));
      const symbols=Array.isArray(msg.params?.arguments?.symbols) && msg.params.arguments.symbols.length
        ? msg.params.arguments.symbols : RADAR;
      const data=await marketData(symbols);
      return res.json(rpcResult(id,{
        content:[{type:"text",text:JSON.stringify(data)}],
        structuredContent:data
      }));
    }
    return res.json(rpcError(id,-32601,"Method not found"));
  } catch(e) {
    return res.json(rpcError(id,-32000,e.message));
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`Hyperliquid Scanner MCP listening on ${PORT}`));
