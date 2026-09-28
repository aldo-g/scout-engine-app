// Cost meter: every model call and search query in a request is counted per
// model and per provider, then priced at list rates. The page adds the steps
// up into the "cost of this run" section of the report. These are estimates
// from token counts, not the invoice; the API dashboards remain the source of
// truth for billing.

// USD per million tokens. Cache reads are a tenth of the input price and cache
// writes a quarter more; the pipeline sends fresh prompts so both stay near zero.
const PRICES = {
  'claude-opus-5': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
};

// USD per query. Serper sells credits in blocks; set SERPER_USD_PER_QUERY in
// .env to your plan's rate (0 on the free tier). Brave is scraped, so free.
const SEARCH_USD = {
  serper: process.env.SERPER_USD_PER_QUERY !== undefined && process.env.SERPER_USD_PER_QUERY !== '' ? Number(process.env.SERPER_USD_PER_QUERY) : 0.001,
  brave: 0,
};

function priceFor(model) {
  if (PRICES[model]) return PRICES[model];
  const k = Object.keys(PRICES).find((p) => String(model || '').startsWith(p));
  return k ? PRICES[k] : null;
}

function createMeter() {
  const models = {};
  const searches = {};
  return {
    // Any Messages API response (messages.parse, messages.create, tool-runner messages).
    model(res) {
      const u = res && res.usage;
      if (!u) return;
      const id = res.model || 'unknown';
      const t = models[id] || (models[id] = { calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 });
      t.calls++;
      t.input += u.input_tokens || 0;
      t.output += u.output_tokens || 0;
      t.cache_read += u.cache_read_input_tokens || 0;
      t.cache_write += u.cache_creation_input_tokens || 0;
    },
    search(provider) {
      searches[provider] = (searches[provider] || 0) + 1;
    },
    report() {
      const out = { models: {}, searches: {}, usd: 0, calls: 0, queries: 0, input: 0, output: 0, priced: true };
      for (const id in models) {
        const t = models[id], p = priceFor(id);
        const usd = p ? (t.input * p.input + t.output * p.output + t.cache_read * p.cache_read + t.cache_write * p.cache_write) / 1e6 : null;
        out.models[id] = { ...t, usd };
        out.calls += t.calls; out.input += t.input + t.cache_read + t.cache_write; out.output += t.output;
        if (usd == null) out.priced = false; else out.usd += usd;
      }
      for (const p in searches) {
        const rate = SEARCH_USD[p];
        const usd = rate == null ? null : searches[p] * rate;
        out.searches[p] = { calls: searches[p], usd };
        out.queries += searches[p];
        if (usd == null) out.priced = false; else out.usd += usd;
      }
      return out;
    },
  };
}

module.exports = { createMeter, PRICES, SEARCH_USD };
