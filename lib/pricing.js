// Model pricing in USD per million tokens, from Anthropic's published pricing
// (cached 2026-07). Costs shown in the app are estimates of API-equivalent
// value: subscription users don't pay per token, but this is the number that
// makes usage comparable (same framing ccusage uses).
//
// Cache multipliers: reads bill at 0.1x input, 5-minute cache writes at 1.25x,
// 1-hour cache writes at 2x.

const PRICES = [
  // [model id prefix, input $/MTok, output $/MTok]
  ['claude-fable-5', 10, 50],
  ['claude-mythos-5', 10, 50],
  ['claude-opus-4-8', 5, 25],
  ['claude-opus-4-7', 5, 25],
  ['claude-opus-4-6', 5, 25],
  ['claude-opus-4-5', 5, 25],
  ['claude-opus-4-1', 15, 75],
  ['claude-opus-4', 15, 75],
  ['claude-opus', 15, 75],
  ['claude-sonnet-5', 3, 15],
  ['claude-sonnet-4-6', 3, 15],
  ['claude-sonnet-4-5', 3, 15],
  ['claude-sonnet-4', 3, 15],
  ['claude-sonnet', 3, 15],
  ['claude-haiku-4-5', 1, 5],
  // legacy 3.x models still present in older transcripts
  ['claude-3-7-sonnet', 3, 15],
  ['claude-3-5-sonnet', 3, 15],
  ['claude-3-sonnet', 3, 15],
  ['claude-3-opus', 15, 75],
  ['claude-3-5-haiku', 0.8, 4],
  ['claude-3-haiku', 0.25, 1.25],
  ['claude-haiku', 1, 5],
];

const CACHE_READ_X = 0.1;
const CACHE_W5_X = 1.25;
const CACHE_W1_X = 2;

function priceFor(modelId) {
  if (!modelId) return null;
  // Normalize Bedrock/Vertex ids: "us.anthropic.claude-opus-4-8-v1:0" -> "claude-opus-4-8..."
  const id = modelId.toLowerCase().replace(/^([a-z]{2}\.)?anthropic\./, '');
  for (const [prefix, input, output] of PRICES) {
    if (id.startsWith(prefix)) return { input, output };
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
    (u.cr || 0) / M * p.input * CACHE_READ_X +
    (u.w5 || 0) / M * p.input * CACHE_W5_X +
    (u.w1 || 0) / M * p.input * CACHE_W1_X
  );
}

module.exports = { priceFor, costOf };
