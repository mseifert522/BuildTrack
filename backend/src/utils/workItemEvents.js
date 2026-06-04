const { v4: uuidv4 } = require('uuid');

function recordWorkItemEvent(db, {
  projectId,
  itemId,
  invoiceId = null,
  actor,
  eventType,
  decision = null,
  before = {},
  after = {},
  comment = null,
  evidenceSummary = null,
}) {
  db.prepare(`
    INSERT INTO work_item_status_events (
      id, project_id, construction_plan_item_id, invoice_id, actor_user_id, actor_role,
      event_type, decision, previous_status, next_status, previous_verification_status,
      next_verification_status, previous_invoice_status, next_invoice_status, comment,
      evidence_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(),
    projectId,
    itemId,
    invoiceId,
    actor.id,
    actor.role,
    eventType,
    decision,
    before.status || null,
    after.status || null,
    before.verification_status || null,
    after.verification_status || null,
    before.invoice_status || null,
    after.invoice_status || null,
    comment || null,
    evidenceSummary ? JSON.stringify(evidenceSummary) : null
  );
}

module.exports = { recordWorkItemEvent };
