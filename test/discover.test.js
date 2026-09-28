// Regression tests for the discovery agent's resilience. Run: node --test test/
//
// The model client and the search provider are replaced with fakes through
// require.cache, so no key and no network are needed.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SEED = 'site:nl.linkedin.com/company "circular economy" Amsterdam after:2025-01-01';
const company = (n) => ({ name: 'Co ' + n, slug: 'co-' + n, url: 'https://nl.linkedin.com/company/co-' + n, snippet: '' });

// Builds a discover() wired to a scripted search and a scripted model.
//   searchImpl(query) -> results array, or throws
//   plannedItems      -> what the planning call returns
//   agentQueries      -> queries the tool-runner fake asks the tool to run, in order
//   agentAttempts     -> instead: one entry per toolRunner() call, { queries, thenThrow }
function load({ searchImpl, plannedItems = [], agentQueries = [], agentAttempts = null }) {
  const attempts = agentAttempts || [{ queries: agentQueries }];
  let attemptNo = 0;
  const seen = { parseOptions: null, runnerOptions: null, toolResults: [] };
  const searchMod = {
    providerFor: () => 'serper',
    search: async (q) => { const results = await searchImpl(q); return { provider: 'serper', query: q, count: results.length, results, notes: [], rate_limited: false }; },
  };
  const fakeClient = {
    messages: { parse: async (params, options) => { seen.parseOptions = options; return { usage: { input_tokens: 1, output_tokens: 1 }, model: 'fake', parsed_output: { items: plannedItems } }; } },
    beta: { messages: { toolRunner: (body, options) => {
      seen.runnerOptions = options;
      seen.openings = (seen.openings || []).concat(body.messages[0].content);
      const tool = body.tools[0];
      const script = attempts[Math.min(attemptNo++, attempts.length - 1)];
      let done = null;
      return {
        async *[Symbol.asyncIterator]() {
          for (const q of script.queries) {
            const out = await tool.run({ query: q, why: 'test' });
            seen.toolResults.push(JSON.parse(out));
            yield { content: [{ type: 'tool_use', id: 't', name: tool.name, input: { query: q } }], usage: { input_tokens: 1, output_tokens: 1 }, model: 'fake' };
          }
          if (script.thenThrow) throw new Error(script.thenThrow);
          done = { content: [{ type: 'text', text: 'summary' }], usage: { input_tokens: 1, output_tokens: 1 }, model: 'fake' };
          yield done;
        },
        done: async () => done,
      };
    } } },
  };
  const FakeSdk = function () { return fakeClient; };
  for (const k of Object.keys(require.cache)) if (k.startsWith(ROOT) && !k.includes('node_modules')) delete require.cache[k];
  require.cache[require.resolve('@anthropic-ai/sdk')] = { id: 'sdk', filename: 'sdk', loaded: true, exports: FakeSdk };
  require.cache[path.join(ROOT, 'search.js')] = { id: 'search', filename: path.join(ROOT, 'search.js'), loaded: true, exports: searchMod };
  process.env.ANTHROPIC_API_KEY = 'test';
  const { discover } = require(path.join(ROOT, 'discover.js'));
  return { discover, seen };
}

const PLAN = [
  { term: 'circulair', query: 'site:nl.linkedin.com/company "circulair" Amsterdam after:2025-01-01', why: 'dutch', group: 'local language', priority: 1 },
  { term: 'recycling', query: 'site:nl.linkedin.com/company "recycling" Amsterdam after:2025-01-01', why: 'adjacent', group: 'adjacent term', priority: 2 },
  { term: 'Haarlem', query: 'site:nl.linkedin.com/company "circular economy" Haarlem after:2025-01-01', why: 'nearby', group: 'nearby place', priority: 3 },
];

test('model calls carry a bounded timeout instead of the 10-minute SDK default', async () => {
  const { discover, seen } = load({ searchImpl: async () => [company(1)], plannedItems: PLAN, agentQueries: ['site:nl.linkedin.com/company "x" after:2025-01-01'] });
  await discover({ query: SEED, budget: 12, since: '2025-01-01' }, () => {});
  for (const [name, opts] of [['messages.parse', seen.parseOptions], ['toolRunner', seen.runnerOptions]]) {
    assert.ok(opts && Number.isFinite(opts.timeout), name + ' should be called with a timeout');
    assert.ok(opts.timeout <= 3 * 60 * 1000, name + ' timeout should be a few minutes at most, got ' + opts.timeout);
  }
});

test('a search error while running the plan skips that query and keeps the run alive', async () => {
  let n = 0;
  const { discover } = load({
    searchImpl: async (q) => { if (/recycling/.test(q)) throw new Error('fetch failed'); return [company(++n)]; },
    plannedItems: PLAN,
  });
  const events = [];
  const out = await discover({ query: SEED, budget: 4, since: '2025-01-01' }, (ev) => events.push(ev));
  assert.deepStrictEqual(out.queries.map((q) => q.query), [SEED, PLAN[0].query, PLAN[2].query], 'seed and the two good planned queries ran');
  assert.strictEqual(out.companies.length, 3);
  assert.ok(events.some((e) => e.type === 'skip' && e.plan_index === 2 && /fetch failed/.test(e.reason)), 'the failed query is reported as skipped with the error');
});

test('a search error in the adaptive phase gives the budget slot back', async () => {
  let n = 0;
  const Q = (s) => 'site:nl.linkedin.com/company "' + s + '" after:2025-01-01';
  const { discover, seen } = load({
    searchImpl: async (q) => { if (/broken/.test(q)) throw new Error('fetch failed'); return [company(++n)]; },
    plannedItems: [],
    agentQueries: [Q('broken'), Q('one'), Q('two')],
  });
  const out = await discover({ query: SEED, budget: 3, since: '2025-01-01' }, () => {});
  assert.ok(seen.toolResults[0].error && /fetch failed/.test(seen.toolResults[0].error), 'the model is told the search failed');
  assert.strictEqual(seen.toolResults[1].error, undefined, 'second query runs');
  assert.strictEqual(seen.toolResults[2].error, undefined, 'third query still fits the budget because the failed one did not count');
  assert.deepStrictEqual(out.queries.map((q) => q.query), [SEED, Q('one'), Q('two')]);
});

test('a model connection failure mid-run restarts the agent with the remaining budget', async () => {
  let n = 0;
  const Q = (s) => 'site:nl.linkedin.com/company "' + s + '" after:2025-01-01';
  const { discover, seen } = load({
    searchImpl: async () => [company(++n)],
    plannedItems: [],
    agentAttempts: [{ queries: [Q('one')], thenThrow: 'Request timed out.' }, { queries: [Q('two'), Q('three')] }],
  });
  const events = [];
  const out = await discover({ query: SEED, budget: 6, since: '2025-01-01' }, (ev) => events.push(ev));
  assert.deepStrictEqual(out.queries.map((q) => q.query), [SEED, Q('one'), Q('two'), Q('three')], 'the second agent carries on where the first stopped');
  assert.ok(events.some((e) => e.type === 'note' && /starting it again with 4 queries left/.test(e.text)), 'the restart is reported');
  assert.ok(/"one"/.test(seen.openings[1]) && /You have 4 more queries/.test(seen.openings[1]), 'the restarted agent is told what already ran');
  assert.strictEqual(out.summary, 'summary', 'the run ends with the second agent\'s summary, not an error');
});

test('a model connection failure with no budget left ends the run with a note', async () => {
  const Q = (s) => 'site:nl.linkedin.com/company "' + s + '" after:2025-01-01';
  const { discover } = load({ searchImpl: async () => [company(1)], plannedItems: [], agentAttempts: [{ queries: [Q('one')], thenThrow: 'Request timed out.' }] });
  const out = await discover({ query: SEED, budget: 2, since: '2025-01-01' }, () => {});
  assert.strictEqual(out.queries.length, 2);
  assert.match(out.summary, /Agent stopped early: Request timed out/);
});
