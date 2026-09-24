// One place that answers "which Anthropic API key does this server use?".
// Order: the key an admin saved in Human Resources (hr_ai_settings, encrypted at
// rest) wins over ANTHROPIC_API_KEY from the environment. hrResumeIntake.js keeps
// its own configuredSettings() for HR status reporting; this helper is the shared
// read-only resolver for other features (Cost Analyzer document scans).
const { getDb } = require('../db/schema');
const { decryptJson } = require('./secureFields');

function cleanKey(value) {
  const normalized = String(value ?? '').replace(/\s+/g, '').trim();
  return normalized || null;
}

function resolveAnthropicApiKey() {
  try {
    const row = getDb().prepare(`
      SELECT api_key_encrypted, api_key_last_four
      FROM hr_ai_settings
      WHERE provider = 'anthropic'
    `).get();
    if (row?.api_key_encrypted) {
      const secret = decryptJson(row.api_key_encrypted);
      const key = cleanKey(secret?.api_key);
      if (key) return { apiKey: key, source: 'managed', lastFour: row.api_key_last_four || key.slice(-4) };
    }
  } catch (err) {
    console.warn('[anthropic-key] managed key unavailable, falling back to environment:', err?.message || err);
  }
  const envKey = cleanKey(process.env.ANTHROPIC_API_KEY);
  if (envKey) return { apiKey: envKey, source: 'environment', lastFour: envKey.slice(-4) };
  return { apiKey: null, source: null, lastFour: null };
}

module.exports = { resolveAnthropicApiKey };
