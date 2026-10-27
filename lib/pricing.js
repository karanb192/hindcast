// Model pricing in USD per million tokens, from Anthropic's published pricing
// (cached 2026-10, first-party API) and OpenAI's (cached 2026-10, standard
// tier, short context). Costs shown in the app are estimates of API-equivalent value:
// subscription users don't pay per token, but this is the number that makes
// usage comparable (same framing ccusage uses).
//
// Cache multipliers: reads bill at 0.1x input unless the entry lists its own
// cached-input rate, 5-minute cache writes at 1.25x, 1-hour cache writes at
// 2x. OpenAI's 30-minute cache writes bill at the same 1.25x.

const PRICES = [
  // [model id prefix, input $/MTok, output $/MTok, cached input $/MTok when
  // it is not 0.1x input]. Point releases first: 'claude-opus-5' would
  // otherwise swallow claude-opus-5-5. Claude Haiku 5.5's rate is for
  // prompts up to 100K tokens; longer prompts bill higher, not applied here.
  ['claude-fable-5-1', 10, 50, 0.25],
  ['claude-fable-5', 10, 50],
  ['claude-mythos-5-1', 10, 50, 0.25],
  ['claude-mythos-5', 10, 50],
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus-5', 5, 25],
  ['claude-opus-4-8', 5, 25],
  ['claude-opus-4-7', 5, 25],
  ['claude-opus-4-6', 5, 25],
  ['claude-opus-4-5', 5, 25],
  ['claude-opus-4-1', 15, 75],
  ['claude-opus-4', 15, 75],
  ['claude-opus', 15, 75],
  ['claude-sonnet-5-5', 2, 10, 0.2],
  ['claude-sonnet-5', 2, 10],
  ['claude-sonnet-4-6', 3, 15],
  ['claude-sonnet-4-5', 3, 15],
  ['claude-sonnet-4', 3, 15],
  ['claude-sonnet', 3, 15],
  ['claude-haiku-5-5', 0.1, 0.5],
  ['claude-haiku-4-5', 1, 5],
  // legacy 3.x models still present in older transcripts
  ['claude-3-7-sonnet', 3, 15],
  ['claude-3-5-sonnet', 3, 15],
  ['claude-3-sonnet', 3, 15],
  ['claude-3-opus', 15, 75],
  ['claude-3-5-haiku', 0.8, 4],
  ['claude-3-haiku', 0.25, 1.25],
  ['claude-haiku', 1, 5],

  // OpenAI: [prefix, input, output, cached input]. Most specific first:
  // 'gpt-5' would otherwise swallow every gpt-5.x id.
  ['gpt-6.1-sol', 2, 10, 0.1],
  ['gpt-6.1-terra', 1, 5, 0.05],
  ['gpt-6-astra', 10, 50, 1],
  ['gpt-6-sol', 2, 10, 0.2],
  ['gpt-6-luna', 0.1, 0.5, 0.01],
  ['gpt-5.6-cyber', 12.5, 75, 1.25],
  ['gpt-5.6-sol', 4, 20, 0.4],
  ['gpt-5.6-terra', 2, 12, 0.2],
  ['gpt-5.6-luna', 0.2, 1.2, 0.02],
  ['gpt-5.5-cyber', 12.5, 75, 1.25],
  ['gpt-5.5-pro', 30, 180, 30],
  ['gpt-5.5', 5, 30, 0.5],
  ['gpt-5.4-pro', 30, 180, 30],
  ['gpt-5.4-mini', 0.75, 4.5, 0.075],
  ['gpt-5.4-nano', 0.2, 1.25, 0.02],
  ['gpt-5.4', 2.5, 15, 0.25],
  ['gpt-5.3-codex', 1.75, 14, 0.175],
  ['gpt-5.2-pro', 21, 168, 21],
  ['gpt-5.2', 1.75, 14, 0.175],
  ['gpt-5.1-codex-mini', 0.25, 2, 0.025],
  ['gpt-5.1', 1.25, 10, 0.125],
  ['gpt-5-pro', 15, 120, 15],
  ['gpt-5-mini', 0.25, 2, 0.025],
  ['gpt-5-nano', 0.05, 0.4, 0.005],
  ['gpt-5', 1.25, 10, 0.125],
];

const CACHE_READ_X = 0.1;
const CACHE_W5_X = 1.25;
const CACHE_W1_X = 2;

function priceFor(modelId) {
  if (!modelId) return null;
  // Normalize Bedrock/Vertex ids: "us.anthropic.claude-opus-4-8-v1:0" and
  // the cross-region "global.anthropic.…" -> "claude-opus-4-8..."
  const id = modelId.toLowerCase().replace(/^([a-z]{2}\.|global\.)?anthropic\./, '');
  for (const [prefix, input, output, cachedInput] of PRICES) {
    if (id.startsWith(prefix)) {
      return { input, output, cacheRead: cachedInput != null ? cachedInput : input * CACHE_READ_X };
    }
  }
  return null;
}

// usage: {in, out, cr, w5, w1} token counts for one model
function costOf(modelId, u) {
  const p = priceFor(modelId);
  if (!p || !u) return null;
  const M = 1e6;
  return (
    (u.in || 0) / M * p.input +
    (u.out || 0) / M * p.output +
    (u.cr || 0) / M * p.cacheRead +
    (u.w5 || 0) / M * p.input * CACHE_W5_X +
    (u.w1 || 0) / M * p.input * CACHE_W1_X
  );
}

// Who serves a model, for the provider rollups and the filter's select-all.
// Bedrock and Vertex spellings of Claude ids count as Anthropic.
const PROVIDER_LABELS = { anthropic: 'Anthropic', openai: 'OpenAI', other: 'Other' };
function providerOf(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (/^(claude-|([a-z]{2}\.|global\.)?anthropic\.)/.test(id)) return 'anthropic';
  if (/^(gpt-|o\d|codex-|chatgpt-|computer-use)/.test(id)) return 'openai';
  return 'other';
}

module.exports = { priceFor, costOf, providerOf, PROVIDER_LABELS };
