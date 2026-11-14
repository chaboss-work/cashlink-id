// BCH/USD price for display only (amounts are always set and signed in BCH).
let cached: { usd: number; at: number } | null = null;

export async function bchUsd(): Promise<number | null> {
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.usd;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd", { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    const usd = Number(j?.["bitcoin-cash"]?.usd);
    if (!usd || !isFinite(usd)) return cached?.usd ?? null;
    cached = { usd, at: Date.now() };
    return usd;
  } catch {
    return cached?.usd ?? null;
  }
}

export const usdText = (sats: bigint, usd: number | null) => {
  if (!usd) return "";
  const v = (Number(sats) / 1e8) * usd;
  return v < 0.01 ? "< $0.01" : `≈ $${v.toFixed(2)}`;
};
