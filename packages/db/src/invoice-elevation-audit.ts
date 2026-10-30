/** Exact editable document values, without customer keys or delivery credentials. */
export const invoiceElevationSnapshotSql = (invoiceId: string): string => `SELECT json_object(
  'header',json_object(
    'id',document.id,'version',document.version,'state',document.state,
    'client_id',document.client_id,'number',document.number,'subject',document.subject,
    'purchase_order',document.purchase_order,'notes',document.notes,'currency',document.currency,
    'issue_date',document.issue_date,'due_date',document.due_date,'payment_terms',document.payment_terms,
    'project_id',document.project_id,'retainer_id',document.retainer_id,
    'reminder_policy',json(document.reminder_policy),'payment_options',json(document.payment_options),
    'tax_rate_ppm',document.tax_rate_ppm,'tax2_rate_ppm',document.tax2_rate_ppm,'discount_rate_ppm',document.discount_rate_ppm,
    'amount_cents',document.amount_cents,'tax_amount_cents',document.tax_amount_cents,
    'tax2_amount_cents',document.tax2_amount_cents,'discount_amount_cents',document.discount_amount_cents
  ),
  'lines',json(COALESCE((SELECT json_group_array(json(line_json)) FROM (
    SELECT json_object('id',line.id,'position',line.position,'kind',line.kind,
      'description',line.description,'quantity',line.quantity,'unit_price_cents',line.unit_price_cents,
      'amount_cents',line.amount_cents,'taxed',line.taxed,'taxed2',line.taxed2,'project_id',line.project_id
    ) AS line_json FROM invoice_line_items line WHERE line.invoice_id=document.id ORDER BY line.position,line.id
  )),'[]'))
) FROM invoices document WHERE document.id=${invoiceId}`

export const invoiceTimeUnlinkSnapshotSql = (
  entryIds: string,
): string => `SELECT COALESCE(json_group_array(json(entry_json)),'[]') FROM (
 SELECT json_object('id',entry.id,'user_id',entry.user_id,'project_id',entry.project_id,'task_id',entry.task_id,
   'spent_date',entry.spent_date,'seconds',entry.seconds,'rounded_seconds',entry.rounded_seconds,
   'invoice_id',entry.invoice_id,'updated_at',entry.updated_at
 ) AS entry_json FROM time_entries entry WHERE entry.id IN(SELECT value FROM json_each(${entryIds})) ORDER BY entry.id
)`
