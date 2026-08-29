export const emailDeliveryDetailsMigration = [
  `ALTER TABLE email_log ADD COLUMN provider_request_id TEXT CHECK (
    provider_request_id IS NULL OR length(trim(provider_request_id)) BETWEEN 1 AND 512
  )`,
  `ALTER TABLE email_log ADD COLUMN provider_latency_ms INTEGER CHECK (
    provider_latency_ms IS NULL OR provider_latency_ms BETWEEN 0 AND 3000000
  )`,
  `ALTER TABLE email_log ADD COLUMN failure_reason TEXT CHECK (
    failure_reason IS NULL OR (
      length(failure_reason) BETWEEN 1 AND 128
      AND failure_reason NOT GLOB '*[^A-Za-z0-9_:]*'
    )
  )`,
  `CREATE TRIGGER email_log_delivery_details_guard
    BEFORE UPDATE OF status, provider_request_id, provider_latency_ms, failure_reason
    ON email_log
    WHEN (
      (NEW.provider_request_id IS NOT NULL OR NEW.provider_latency_ms IS NOT NULL)
        AND NEW.status NOT IN ('sent','bounced','complained')
    ) OR (
      NEW.failure_reason IS NOT NULL
        AND (NEW.status <> 'failed' OR NEW.failure_code <> 'provider_rejected')
    )
    BEGIN SELECT RAISE(ABORT, 'email log delivery details do not match status'); END`,
  `CREATE TRIGGER email_log_delivery_details_insert_guard
    BEFORE INSERT ON email_log
    WHEN (
      (NEW.provider_request_id IS NOT NULL OR NEW.provider_latency_ms IS NOT NULL)
        AND NEW.status NOT IN ('sent','bounced','complained')
    ) OR (
      NEW.failure_reason IS NOT NULL
        AND (NEW.status <> 'failed' OR NEW.failure_code <> 'provider_rejected')
    )
    BEGIN SELECT RAISE(ABORT, 'email log delivery details do not match status'); END`,
] as const
