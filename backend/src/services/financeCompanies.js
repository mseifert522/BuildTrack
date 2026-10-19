'use strict';
const crypto = require('crypto');
const FINANCE_URL = 'https://finance.seifertcapital.com';
const normalizeName = value => String(value || '').toLowerCase().replace(/\b(incorporated|inc|llc|ltd|group|partners|corporation|corp)\b/g, '').replace(/[^a-z0-9]/g, '');

// Reuse BuildTrack's encrypted credential store and serialized token refresh.
// Extra company rows are deliberately outside its primary operational ledger.
module.exports = function createFinanceCompanies({ getDb, qboConfig, qboEnvironment, qboApiBase, redirectUri, tokenRequest, encryptSecret, addSeconds, qboRequest, qboQuery, logActivity }) {
  function list() {
    return getDb().prepare("SELECT id, realm_id, company_name, environment, is_active FROM quickbooks_connections WHERE id LIKE 'finance:%' AND is_active = 1").all().map(c => ({ tenantId: c.id.slice(8), realmId: c.realm_id, companyName: c.company_name, environment: c.environment }));
  }
  function connect(tenantId, companyName) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(tenantId) || typeof companyName !== 'string' || companyName.length < 2 || companyName.length > 150) throw new Error('Invalid finance entity.');
    const db = getDb(), config = qboConfig();
    if (!config.configured || config.environment !== 'production') throw new Error('Production Intuit app is not configured.');
    const primary = db.prepare("SELECT connected_by FROM quickbooks_connections WHERE id = 'primary' AND is_active = 1").get();
    if (!primary?.connected_by) throw new Error('Existing QuickBooks connection owner is unavailable.');
    const payload = Buffer.from(JSON.stringify({ tenantId, companyName })).toString('base64url');
    const state = `ft1:${payload}:${crypto.randomBytes(32).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO quickbooks_oauth_states (state,user_id,expires_at) VALUES (?,?,?)').run(state, primary.connected_by, expiresAt);
    const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: config.scope, state });
    return { authUrl: `https://appcenter.intuit.com/connect/oauth2?${params}`, expiresAt };
  }
  async function complete(req, res, db, savedState) {
    res.setHeader('Cache-Control', 'no-store');
    let tenantId = '';
    try {
      const parts = savedState.state.split(':');
      if (parts.length !== 3 || !/^[a-f0-9]{64}$/.test(parts[2])) throw new Error('Invalid finance authorization state.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      tenantId = payload.tenantId;
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(tenantId)) throw new Error('Invalid finance entity.');
      const realmId = String(req.query.realmId || '');
      if (!/^\d+$/.test(realmId)) throw new Error('Invalid company identifier.');
      // An accidental company selection must never replace an existing owner.
      const duplicate = db.prepare('SELECT id FROM quickbooks_connections WHERE realm_id = ? AND id != ? AND is_active = 1').get(realmId, `finance:${tenantId}`);
      const existing = db.prepare('SELECT realm_id FROM quickbooks_connections WHERE id = ?').get(`finance:${tenantId}`);
      if (duplicate || realmId === '9130355719043726' || (existing && existing.realm_id !== realmId)) throw new Error('That company already belongs to another connection, or does not match this entity.');
      const claimed = db.prepare("UPDATE quickbooks_oauth_states SET used_at = datetime('now') WHERE state = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')").run(savedState.state);
      if (claimed.changes !== 1) throw new Error('Authorization state already used.');
      const token = await tokenRequest({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: redirectUri() });
      const response = await fetch(`${qboApiBase()}/v3/company/${encodeURIComponent(realmId)}/companyinfo/${encodeURIComponent(realmId)}`, { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error('Unable to verify the selected QuickBooks company.');
      const company = (await response.json()).CompanyInfo;
      const expected = normalizeName(payload.companyName);
      if (![company?.CompanyName, company?.LegalName].some(n => normalizeName(n) === expected)) throw new Error('Selected QuickBooks company name does not match the requested entity.');
      const companyName = company.CompanyName || company.LegalName;
      db.prepare(`INSERT INTO quickbooks_connections (id,realm_id,environment,company_name,scope,access_token_encrypted,refresh_token_encrypted,access_token_expires_at,connected_by,is_active,last_sync_status)
        VALUES (?,?,?,?,?,?,?,?,?,1,'connected') ON CONFLICT(id) DO UPDATE SET company_name=excluded.company_name,scope=excluded.scope,access_token_encrypted=excluded.access_token_encrypted,refresh_token_encrypted=excluded.refresh_token_encrypted,access_token_expires_at=excluded.access_token_expires_at,is_active=1,updated_at=datetime('now'),last_sync_status='connected',last_sync_error=NULL`).run(`finance:${tenantId}`,realmId,qboEnvironment(),companyName,token.scope || qboConfig().scope,encryptSecret(token.access_token),encryptSecret(token.refresh_token),addSeconds(token.expires_in || 3600),savedState.user_id);
      logActivity({ userId: savedState.user_id, action: 'finance_company_connected', entityType: 'quickbooks_connection', entityId: realmId, details: { tenantId, company_name: companyName, source: 'finance_tracker' } });
      return res.redirect(303, `${FINANCE_URL}/api/quickbooks/complete?tenant=${encodeURIComponent(tenantId)}`);
    } catch (error) {
      // No authorization codes or tokens in logs, URLs or UI errors.
      console.error('[Finance QBO] Company authorization failed:', error.message);
      return res.redirect(303, `${FINANCE_URL}/overview?connection=failed`);
    }
  }
  async function reports(tenantId, year) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(tenantId) || !Number.isInteger(year) || year < 2020 || year > new Date().getUTCFullYear()) throw new Error('Invalid company report request.');
    const db = getDb();
    const connection = db.prepare("SELECT * FROM quickbooks_connections WHERE id = ? AND is_active = 1 AND environment = 'production'").get(`finance:${tenantId}`);
    if (!connection) throw new Error('Company authorization is not connected.');
    const accounts = [];
    for (let start = 1; ; start += 1000) {
      const page = await qboQuery(db, connection, `select * from Account where Active in (true, false) STARTPOSITION ${start} MAXRESULTS 1000`);
      if (!page.QueryResponse) throw new Error('Account export was incomplete.');
      const rows = page.QueryResponse.Account || [];
      accounts.push(...rows.map(a => ({ Id:a.Id,Name:a.Name,FullyQualifiedName:a.FullyQualifiedName,AcctNum:a.AcctNum,AccountType:a.AccountType,AccountSubType:a.AccountSubType,Classification:a.Classification,Active:a.Active })));
      if (rows.length < 1000) break;
      if (start >= 10001) throw new Error('Account pagination exceeded safety limit.');
    }
    const end = year === new Date().getUTCFullYear() ? new Date().toISOString().slice(0,10) : `${year}-12-31`;
    const root = `/v3/company/${encodeURIComponent(connection.realm_id)}/reports`;
    const [balanceSheet,profitLoss] = await Promise.all([
      qboRequest(db,connection,`${root}/BalanceSheet?accounting_method=Accrual&date_macro=Today`),
      qboRequest(db,connection,`${root}/ProfitAndLoss?accounting_method=Accrual&start_date=${year}-01-01&end_date=${end}`),
    ]);
    return { company:{realmId:connection.realm_id,name:connection.company_name},accounts,balanceSheet,profitLoss };
  }
  return { list,connect,complete,reports };
};
module.exports.normalizeName = normalizeName;
