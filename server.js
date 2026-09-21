const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const HL_API = "https://api.hyperliquid.xyz/info";
const RADAR = ["BTC","ETH","SOL","HYPE","ZEC","PUMP","LIT","ENA","AVAX","TAO"];

async function hyperliquid(body) {
  const response = await fetch(HL_API, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
  return response.json();
}

app.get("/", (req,res) => res.json({
  service:"Hyperliquid Scanner",
  status:"online",
  endpoints:["/market"],
  timestamp:new Date().toISOString()
}));

app.get("/market", async (req,res) => {
  try {
    const result = await hyperliquid({type:"metaAndAssetCtxs"});
    const meta=result[0], ctxs=result[1], markets={};
    for (let i=0;i<meta.universe.length;i++) {
      const asset=meta.universe[i], ctx=ctxs[i];
      if (!RADAR.includes(asset.name)) continue;
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
    res.set("Cache-Control","no-store");
    res.json({source:"Hyperliquid Mainnet",timestamp:new Date().toISOString(),markets});
  } catch (e) {
    res.status(500).json({error:e.message,timestamp:new Date().toISOString()});
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`Hyperliquid Scanner listening on ${PORT}`));
