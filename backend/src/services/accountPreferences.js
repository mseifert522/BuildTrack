'use strict';

const COLOR_SCHEMES = Object.freeze(['01', '07', '08', '02', 'dark-knight']);
const DEFAULT_COLOR_SCHEME = '07';

function normalizeColorScheme(value) {
  return COLOR_SCHEMES.includes(value) ? value : DEFAULT_COLOR_SCHEME;
}

// Browser session presence does not describe an API service account.
function agentDirectoryMetadata(db) {
  const linked = new Map();
  for (const agent of db.prepare('SELECT agent_name, enabled, acts_as_user_id, last_used_at FROM agent_bridge_agents WHERE acts_as_user_id IS NOT NULL').all()) {
    const current = linked.get(agent.acts_as_user_id);
    if (!current || agent.enabled > current.enabled) linked.set(agent.acts_as_user_id, agent);
  }
  return linked;
}

module.exports = { COLOR_SCHEMES, DEFAULT_COLOR_SCHEME, normalizeColorScheme, agentDirectoryMetadata };
