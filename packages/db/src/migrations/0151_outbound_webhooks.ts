import { webhookEventTypesV1, webhookDeliveryErrorsV1 } from '@ezacto/core'
import { canonicalTimestamp } from './0029_outbox_delivery.js'
// Both imported vocabularies are frozen v1 contracts. New events/error codes need a new migration.
const events = webhookEventTypesV1.map((value) => `'${value}'`).join(',')
const errors = webhookDeliveryErrorsV1.map((value) => `'${value}'`).join(',')
const sealedSecret = (
  field: string,
) => `${field} IS NULL OR coalesce((json_valid(${field}) AND json_type(${field})='object'
  AND json_extract(${field},'$.version')=1
  AND json_type(${field},'$.key_id')='text' AND length(json_extract(${field},'$.key_id'))=32
  AND json_type(${field},'$.nonce')='text' AND length(json_extract(${field},'$.nonce'))=16
  AND json_type(${field},'$.ciphertext')='text' AND length(json_extract(${field},'$.ciphertext'))=86),0)`
const nullableTime = (field: string) => `${field} IS NULL OR (${canonicalTimestamp(field)})`
export const outboundWebhooksMigration = [
  `CREATE TABLE webhook_subscriptions (
    id TEXT PRIMARY KEY CHECK(length(id)=36),
    url TEXT NOT NULL CHECK(length(url) BETWEEN 1 AND 2048 AND substr(url,1,8)='https://'),
    events_json TEXT NOT NULL CHECK(json_valid(events_json) AND json_type(events_json)='array' AND json_array_length(events_json) BETWEEN 1 AND 19),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
    version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
    generation INTEGER NOT NULL CHECK(generation>=1),
    current_secret TEXT CHECK(${sealedSecret('current_secret')}),
    previous_secret TEXT CHECK(${sealedSecret('previous_secret')}),
    previous_generation INTEGER,
    previous_valid_until TEXT CHECK(${nullableTime('previous_valid_until')}),
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL CHECK(${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK(${canonicalTimestamp('updated_at')}),
    deleted_at TEXT CHECK(${nullableTime('deleted_at')}),
    CHECK(julianday(updated_at)>=julianday(created_at)),
    CHECK((previous_secret IS NULL AND previous_generation IS NULL AND previous_valid_until IS NULL)
      OR (previous_secret IS NOT NULL AND previous_generation=generation-1 AND previous_valid_until IS NOT NULL)),
    CHECK((deleted_at IS NULL AND current_secret IS NOT NULL)
      OR (deleted_at IS NOT NULL AND is_active=0 AND current_secret IS NULL AND previous_secret IS NULL))
  ) STRICT`,
  ...['INSERT', 'UPDATE'].map(
    (
      verb,
    ) => `CREATE TRIGGER webhook_secret_fields_${verb.toLowerCase()} BEFORE ${verb} ON webhook_subscriptions
    WHEN EXISTS(SELECT 1 FROM json_each(NEW.current_secret) WHERE key NOT IN ('version','key_id','nonce','ciphertext'))
      OR EXISTS(SELECT 1 FROM json_each(NEW.previous_secret) WHERE key NOT IN ('version','key_id','nonce','ciphertext'))
    BEGIN SELECT RAISE(ABORT,'invalid_webhook_secret_envelope'); END`,
  ),
  `CREATE TRIGGER webhook_subscription_events_insert BEFORE INSERT ON webhook_subscriptions WHEN
    EXISTS(SELECT 1 FROM json_each(NEW.events_json) WHERE type<>'text' OR value NOT IN (${events}))
    OR (SELECT count(*) FROM json_each(NEW.events_json))<>(SELECT count(DISTINCT value) FROM json_each(NEW.events_json))
    BEGIN SELECT RAISE(ABORT,'invalid_webhook_events'); END`,
  `CREATE TRIGGER webhook_subscription_capacity BEFORE INSERT ON webhook_subscriptions
    WHEN (SELECT count(*) FROM webhook_subscriptions WHERE deleted_at IS NULL)>=25
    BEGIN SELECT RAISE(ABORT,'webhook_subscription_limit'); END`,
  `CREATE TRIGGER webhook_subscription_identity BEFORE UPDATE ON webhook_subscriptions WHEN
    NEW.id IS NOT OLD.id OR NEW.url IS NOT OLD.url OR NEW.events_json IS NOT OLD.events_json
    OR NEW.created_at IS NOT OLD.created_at OR NEW.version<OLD.version OR NEW.generation<OLD.generation
    OR (NEW.current_secret IS NOT OLD.current_secret AND NEW.deleted_at IS NULL AND NEW.generation<>OLD.generation+1)
    OR (OLD.deleted_at IS NOT NULL AND (NEW.deleted_at IS NOT OLD.deleted_at OR NEW.is_active<>0 OR NEW.current_secret IS NOT NULL OR NEW.previous_secret IS NOT NULL))
    BEGIN SELECT RAISE(ABORT,'webhook_subscription_immutable'); END`,
  `CREATE TABLE webhook_deliveries (
    id TEXT PRIMARY KEY CHECK(length(id)=32 AND id NOT GLOB '*[^0-9a-f]*'),
    subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE RESTRICT,
    event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 1 AND 200),
    event_type TEXT NOT NULL CHECK(event_type IN (${events})),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(payload_json)<=16384),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','delivered','failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
    cycle_attempts INTEGER NOT NULL DEFAULT 0 CHECK(cycle_attempts BETWEEN 0 AND 5),
    replay_count INTEGER NOT NULL DEFAULT 0 CHECK(replay_count>=0),
    lease_token TEXT,
    lease_expires_at TEXT CHECK(${nullableTime('lease_expires_at')}),
    next_attempt_at TEXT CHECK(${nullableTime('next_attempt_at')}),
    last_attempt_at TEXT CHECK(${nullableTime('last_attempt_at')}),
    last_status INTEGER CHECK(last_status IS NULL OR last_status BETWEEN 100 AND 599),
    last_error_code TEXT CHECK(last_error_code IS NULL OR last_error_code IN (${errors})),
    delivered_at TEXT CHECK(${nullableTime('delivered_at')}),
    failed_at TEXT CHECK(${nullableTime('failed_at')}),
    created_at TEXT NOT NULL CHECK(${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK(${canonicalTimestamp('updated_at')}),
    UNIQUE(subscription_id,event_id),
    CHECK((status='processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status<>'processing' AND lease_token IS NULL AND lease_expires_at IS NULL))
  ) STRICT`,
  `CREATE INDEX webhook_deliveries_due ON webhook_deliveries(status,next_attempt_at,lease_expires_at) WHERE status IN ('pending','processing')`,
  `CREATE INDEX webhook_deliveries_history ON webhook_deliveries(subscription_id,created_at,id)`,
  `CREATE TRIGGER webhook_delivery_identity BEFORE UPDATE ON webhook_deliveries WHEN
    NEW.id IS NOT OLD.id OR NEW.subscription_id IS NOT OLD.subscription_id OR NEW.event_id IS NOT OLD.event_id
    OR NEW.event_type IS NOT OLD.event_type OR NEW.payload_json IS NOT OLD.payload_json OR NEW.created_at IS NOT OLD.created_at
    OR NEW.attempt_count<OLD.attempt_count OR NEW.replay_count<OLD.replay_count
    BEGIN SELECT RAISE(ABORT,'webhook_delivery_immutable'); END`,
  `CREATE TABLE webhook_command_guard (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),allowed INTEGER NOT NULL CHECK(allowed=1)
  ) STRICT`,
  `CREATE TRIGGER webhook_outbox_fanout AFTER INSERT ON event_outbox
    WHEN NEW.event_type IN (${events}) AND length(NEW.id) BETWEEN 1 AND 200
      AND NEW.id NOT GLOB '*[^A-Za-z0-9_.:-]*' AND NEW.aggregate_id BETWEEN 1 AND 9007199254740991
      AND ((NEW.event_type LIKE 'time_entry.%' AND NEW.aggregate_type='time_entry')
        OR (NEW.event_type NOT LIKE 'time_entry.%' AND NEW.aggregate_type='invoice'))
    BEGIN
      INSERT OR IGNORE INTO webhook_deliveries(id,subscription_id,event_id,event_type,payload_json,next_attempt_at,created_at,updated_at)
      SELECT lower(hex(randomblob(16))),subscription.id,NEW.id,NEW.event_type,
        json_object('schema_version',1,'event_id',NEW.id,'event_type',NEW.event_type,'occurred_at',NEW.occurred_at,
          'resource',json_object('type',NEW.aggregate_type,'id',NEW.aggregate_id,'sequence',NEW.aggregate_sequence),
          'links',json_object('resource',CASE WHEN NEW.aggregate_type='invoice' THEN '/api/v1/invoices/' ELSE '/api/v1/time-entries/' END||NEW.aggregate_id)),
        NEW.available_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM webhook_subscriptions subscription WHERE subscription.is_active=1 AND subscription.deleted_at IS NULL
        AND EXISTS(SELECT 1 FROM json_each(subscription.events_json) WHERE value=NEW.event_type);
    END`,
] as const
