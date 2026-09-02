const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND CAST(substr(${column}, 12, 2) AS INTEGER) BETWEEN 0 AND 23
  AND CAST(substr(${column}, 15, 2) AS INTEGER) BETWEEN 0 AND 59
  AND CAST(substr(${column}, 18, 2) AS INTEGER) BETWEEN 0 AND 59
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9]Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9]Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

const templateKinds = `(
  'invoice','reminder','thank_you','auth_email_verification','auth_password_reset'
)`

const seededAt = '1970-01-01T00:00:00.000Z'

export const emailTemplatesMigration = [
  `ALTER TABLE email_log ADD COLUMN from_json TEXT CHECK (
    from_json IS NULL OR (json_valid(from_json) AND json_type(from_json) = 'object')
  )`,
  `ALTER TABLE email_log ADD COLUMN reply_to_json TEXT CHECK (
    reply_to_json IS NULL OR (json_valid(reply_to_json) AND json_type(reply_to_json) = 'array')
  )`,
  `CREATE TRIGGER email_log_sender_metadata_immutable
    BEFORE UPDATE OF from_json, reply_to_json ON email_log
    WHEN OLD.from_json IS NOT NEW.from_json OR OLD.reply_to_json IS NOT NEW.reply_to_json
    BEGIN SELECT RAISE(ABORT, 'email log sender metadata is immutable'); END`,
  `CREATE TRIGGER email_log_sender_metadata_guard BEFORE INSERT ON email_log
    WHEN NEW.from_json IS NULL
      OR json_type(NEW.from_json, '$.email') IS NOT 'text'
      OR (SELECT count(*) FROM json_each(NEW.from_json) field
          WHERE field.key = 'email') <> 1
      OR (SELECT count(*) FROM json_each(NEW.from_json) field
          WHERE field.key = 'name') > 1
      OR EXISTS (
        SELECT 1 FROM json_each(NEW.from_json) field
        WHERE field.key NOT IN ('email','name')
      )
      OR length(trim(json_extract(NEW.from_json, '$.email'))) NOT BETWEEN 3 AND 254
      OR (json_type(NEW.from_json, '$.name') IS NOT NULL
          AND json_type(NEW.from_json, '$.name') <> 'text')
      OR NEW.reply_to_json IS NOT NULL AND (
        json_array_length(NEW.reply_to_json) NOT BETWEEN 1 AND 10
        OR EXISTS (
          SELECT 1 FROM json_each(NEW.reply_to_json) recipient
          WHERE recipient.type <> 'object'
            OR (SELECT count(*) FROM json_each(recipient.value) field
                WHERE field.key = 'email') <> 1
            OR json_type(recipient.value, '$.email') IS NOT 'text'
            OR length(trim(json_extract(recipient.value, '$.email'))) NOT BETWEEN 3 AND 254
            OR (SELECT count(*) FROM json_each(recipient.value) field
                WHERE field.key = 'name') > 1
            OR EXISTS (
              SELECT 1 FROM json_each(recipient.value) field
              WHERE field.key NOT IN ('email','name')
            )
            OR (json_type(recipient.value, '$.name') IS NOT NULL
                AND json_type(recipient.value, '$.name') <> 'text')
        )
      )
    BEGIN SELECT RAISE(ABORT, 'email log sender metadata is invalid'); END`,
  `CREATE TABLE email_template_versions (
    template_kind TEXT NOT NULL CHECK (template_kind IN ${templateKinds}),
    version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
    subject_template TEXT NOT NULL CHECK (
      length(trim(subject_template)) BETWEEN 1 AND 998
    ),
    text_template TEXT NOT NULL CHECK (
      length(trim(text_template)) BETWEEN 1 AND 1000000
    ),
    html_template TEXT CHECK (
      html_template IS NULL OR length(trim(html_template)) BETWEEN 1 AND 2000000
    ),
    unknown_variable_policy TEXT NOT NULL DEFAULT 'error' CHECK (
      unknown_variable_policy IN ('error','literal')
    ),
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    PRIMARY KEY (template_kind, version)
  ) STRICT`,
  `CREATE TABLE email_template_heads (
    template_kind TEXT PRIMARY KEY CHECK (template_kind IN ${templateKinds}),
    current_version INTEGER NOT NULL CHECK (
      current_version BETWEEN 1 AND 9007199254740991
    ),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    FOREIGN KEY (template_kind, current_version)
      REFERENCES email_template_versions(template_kind, version) ON DELETE RESTRICT
  ) STRICT`,
  `CREATE TABLE email_template_commands (
    command_id TEXT PRIMARY KEY CHECK (
      length(command_id) BETWEEN 1 AND 128
      AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
    template_kind TEXT NOT NULL CHECK (template_kind IN ${templateKinds}),
    expected_version INTEGER NOT NULL CHECK (
      expected_version BETWEEN 1 AND 9007199254740991
    ),
    result_version INTEGER NOT NULL CHECK (
      result_version = expected_version + 1
      AND result_version BETWEEN 2 AND 9007199254740991
    ),
    actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    input_fingerprint TEXT NOT NULL CHECK (
      length(input_fingerprint) = 71
      AND substr(input_fingerprint, 1, 7) = 'sha256:'
      AND substr(input_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    occurred_at TEXT NOT NULL CHECK (${canonicalTimestamp('occurred_at')}),
    result_json TEXT NOT NULL CHECK (
      json_valid(result_json) AND json_type(result_json) = 'object'
      AND json_extract(result_json, '$.schema_version') = 1
    ),
    FOREIGN KEY (template_kind, result_version)
      REFERENCES email_template_versions(template_kind, version) ON DELETE RESTRICT
  ) STRICT`,
  `CREATE TABLE sender_identities (
    id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
    email TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (
      length(email) BETWEEN 3 AND 254
      AND email = lower(trim(email))
      AND instr(email, ' ') = 0
      AND instr(email, '@') > 1
      AND instr(substr(email, instr(email, '@') + 1), '@') = 0
      AND instr(substr(email, instr(email, '@') + 1), '.') > 1
      AND substr(email, instr(email, '@') + 1) NOT GLOB '*[^a-z0-9.-]*'
      AND substr(email, instr(email, '@') + 1) NOT LIKE '.%'
      AND substr(email, instr(email, '@') + 1) NOT LIKE '%.'
      AND substr(email, instr(email, '@') + 1) NOT LIKE '%..%'
      AND substr(email, instr(email, '@') + 1) NOT LIKE '-%'
      AND substr(email, instr(email, '@') + 1) NOT LIKE '%-'
      AND substr(email, instr(email, '@') + 1) NOT LIKE '%.-%'
      AND substr(email, instr(email, '@') + 1) NOT LIKE '%-.%'
    ),
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 200),
    reply_to_email TEXT COLLATE NOCASE CHECK (
      reply_to_email IS NULL OR (
        length(reply_to_email) BETWEEN 3 AND 254
        AND reply_to_email = lower(trim(reply_to_email))
        AND instr(reply_to_email, ' ') = 0
        AND instr(reply_to_email, '@') > 1
        AND instr(substr(reply_to_email, instr(reply_to_email, '@') + 1), '@') = 0
        AND instr(substr(reply_to_email, instr(reply_to_email, '@') + 1), '.') > 1
        AND substr(reply_to_email, instr(reply_to_email, '@') + 1)
          NOT GLOB '*[^a-z0-9.-]*'
        AND substr(reply_to_email, instr(reply_to_email, '@') + 1) NOT LIKE '.%'
        AND substr(reply_to_email, instr(reply_to_email, '@') + 1) NOT LIKE '%.'
        AND substr(reply_to_email, instr(reply_to_email, '@') + 1) NOT LIKE '%..%'
        AND substr(reply_to_email, instr(reply_to_email, '@') + 1) NOT LIKE '-%'
        AND substr(reply_to_email, instr(reply_to_email, '@') + 1) NOT LIKE '%-'
        AND substr(reply_to_email, instr(reply_to_email, '@') + 1) NOT LIKE '%.-%'
        AND substr(reply_to_email, instr(reply_to_email, '@') + 1) NOT LIKE '%-.%'
      )
    ),
    provider TEXT NOT NULL CHECK (
      length(provider) BETWEEN 1 AND 64
      AND provider = lower(trim(provider))
      AND provider NOT GLOB '*[^a-z0-9_-]*'
    ),
    provider_identity TEXT NOT NULL CHECK (
      length(trim(provider_identity)) BETWEEN 1 AND 320
    ),
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
    version INTEGER NOT NULL DEFAULT 0 CHECK (
      version BETWEEN 0 AND 9007199254740991
    ),
    archived_at TEXT CHECK (
      archived_at IS NULL OR (${canonicalTimestamp('archived_at')})
    ),
    created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    CHECK (archived_at IS NULL OR is_default = 0),
    CHECK (julianday(updated_at) >= julianday(created_at)),
    CHECK (archived_at IS NULL OR julianday(archived_at) >= julianday(created_at)),
    UNIQUE (provider, provider_identity, email)
  ) STRICT`,
  `CREATE UNIQUE INDEX sender_identities_default_unique
    ON sender_identities(is_default) WHERE is_default = 1 AND archived_at IS NULL`,
  `CREATE TABLE sender_identity_evidence (
    sender_identity_id INTEGER NOT NULL REFERENCES sender_identities(id) ON DELETE RESTRICT,
    evidence_version INTEGER NOT NULL CHECK (
      evidence_version BETWEEN 1 AND 9007199254740991
    ),
    source TEXT NOT NULL CHECK (source IN ('provider_api','deployment_config')),
    identity_kind TEXT NOT NULL CHECK (identity_kind IN ('email_address','domain')),
    verification_status TEXT NOT NULL CHECK (
      verification_status IN (
        'pending','verified','failed','temporary_failure','operator_configured'
      )
    ),
    dkim_status TEXT NOT NULL CHECK (
      dkim_status IN ('pending','verified','failed','not_applicable')
    ),
    mail_from_domain TEXT CHECK (
      mail_from_domain IS NULL OR (
        length(mail_from_domain) BETWEEN 1 AND 253
        AND mail_from_domain = lower(trim(mail_from_domain))
        AND mail_from_domain NOT GLOB '*[^a-z0-9.-]*'
        AND mail_from_domain NOT LIKE '.%'
        AND mail_from_domain NOT LIKE '%.'
        AND mail_from_domain NOT LIKE '%..%'
      )
    ),
    mail_from_status TEXT NOT NULL CHECK (
      mail_from_status IN ('pending','verified','failed','not_configured')
    ),
    observed_at TEXT NOT NULL CHECK (${canonicalTimestamp('observed_at')}),
    PRIMARY KEY (sender_identity_id, evidence_version),
    CHECK ((mail_from_domain IS NULL) = (mail_from_status = 'not_configured')),
    CHECK (
      (source = 'provider_api' AND verification_status <> 'operator_configured')
      OR (
        source = 'deployment_config'
        AND verification_status = 'operator_configured'
        AND identity_kind = 'email_address'
        AND dkim_status = 'not_applicable'
        AND mail_from_domain IS NULL
        AND mail_from_status = 'not_configured'
      )
    )
  ) STRICT`,
  `CREATE INDEX sender_identity_evidence_latest
    ON sender_identity_evidence(sender_identity_id, evidence_version DESC)`,
  `CREATE TABLE sender_identity_commands (
    command_id TEXT PRIMARY KEY CHECK (
      length(command_id) BETWEEN 1 AND 128
      AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
    command_kind TEXT NOT NULL CHECK (command_kind IN (
      'sender.create','sender.update','sender.default','sender.archive','sender.evidence'
    )),
    sender_identity_id INTEGER NOT NULL REFERENCES sender_identities(id) ON DELETE RESTRICT,
    actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    input_fingerprint TEXT NOT NULL CHECK (
      length(input_fingerprint) = 71
      AND substr(input_fingerprint, 1, 7) = 'sha256:'
      AND substr(input_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    occurred_at TEXT NOT NULL CHECK (${canonicalTimestamp('occurred_at')}),
    result_json TEXT NOT NULL CHECK (
      json_valid(result_json) AND json_type(result_json) = 'object'
      AND json_extract(result_json, '$.schema_version') = 1
    )
  ) STRICT`,
  `CREATE TABLE email_test_send_commands (
    command_id TEXT PRIMARY KEY CHECK (
      length(command_id) BETWEEN 1 AND 128
      AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
    sender_identity_id INTEGER NOT NULL REFERENCES sender_identities(id) ON DELETE RESTRICT,
    template_kind TEXT NOT NULL CHECK (
      template_kind IN ('invoice','reminder','thank_you')
    ),
    template_version INTEGER NOT NULL CHECK (
      template_version BETWEEN 1 AND 9007199254740991
    ),
    actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    input_fingerprint TEXT NOT NULL CHECK (
      length(input_fingerprint) = 71
      AND substr(input_fingerprint, 1, 7) = 'sha256:'
      AND substr(input_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    status TEXT NOT NULL CHECK (status IN ('pending','completed','failed')),
    delivery_id INTEGER REFERENCES email_log(id) ON DELETE RESTRICT,
    failure_code TEXT CHECK (
      failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 128
    ),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    FOREIGN KEY (template_kind, template_version)
      REFERENCES email_template_versions(template_kind, version) ON DELETE RESTRICT,
    CHECK (julianday(updated_at) >= julianday(created_at)),
    CHECK (
      (status = 'pending' AND delivery_id IS NULL AND failure_code IS NULL)
      OR (status = 'completed' AND delivery_id IS NOT NULL AND failure_code IS NULL)
      OR (status = 'failed' AND delivery_id IS NULL AND failure_code IS NOT NULL)
    )
  ) STRICT`,
  `CREATE TABLE _email_configuration_assertions (
    ok INTEGER NOT NULL CHECK (ok = 1)
  ) STRICT`,
  `INSERT INTO email_template_versions (
    template_kind, version, subject_template, text_template,
    unknown_variable_policy, created_at
  ) VALUES
    ('invoice', 1, 'Invoice #%invoice_id% from %company_name%',
      'Please find invoice %invoice_number% for %invoice_amount%. Payment is due %invoice_due_date%.',
      'error', '${seededAt}'),
    ('reminder', 1, 'Reminder: invoice #%invoice_id% from %company_name%',
      'Invoice %invoice_number% for %invoice_amount% is due on %invoice_due_date%.',
      'error', '${seededAt}'),
    ('thank_you', 1, 'Payment received for invoice #%invoice_id%',
      'Thank you. Payment for invoice %invoice_number% from %company_name% has been recorded.',
      'error', '${seededAt}'),
    ('auth_email_verification', 1, 'Verify your %company_name% email',
      'Verify your email: %action_url%\n\nThis one-time link expires at %expires_at%.',
      'error', '${seededAt}'),
    ('auth_password_reset', 1, 'Reset your %company_name% password',
      'Reset your password: %action_url%\n\nThis one-time link expires at %expires_at%.',
      'error', '${seededAt}')`,
  `INSERT INTO email_template_heads (template_kind, current_version, updated_at)
    SELECT template_kind, version, created_at FROM email_template_versions`,
  `CREATE TRIGGER email_template_version_sequence_guard
    BEFORE INSERT ON email_template_versions
    WHEN NEW.version <> COALESCE((
      SELECT current_version + 1 FROM email_template_heads
      WHERE template_kind = NEW.template_kind
    ), 1)
    BEGIN SELECT RAISE(ABORT, 'email template version is not the next version'); END`,
  `CREATE TRIGGER email_template_versions_immutable_update
    BEFORE UPDATE ON email_template_versions
    BEGIN SELECT RAISE(ABORT, 'email template versions are immutable'); END`,
  `CREATE TRIGGER email_template_versions_immutable_delete
    BEFORE DELETE ON email_template_versions
    BEGIN SELECT RAISE(ABORT, 'email template versions are immutable'); END`,
  `CREATE TRIGGER email_template_heads_no_delete
    BEFORE DELETE ON email_template_heads
    BEGIN SELECT RAISE(ABORT, 'email template heads cannot be deleted'); END`,
  `CREATE TRIGGER email_template_heads_sequence_guard
    BEFORE UPDATE ON email_template_heads
    WHEN NEW.current_version <> OLD.current_version + 1
    BEGIN SELECT RAISE(ABORT, 'email template head must advance exactly one version'); END`,
  `CREATE TRIGGER email_template_commands_immutable_update
    BEFORE UPDATE ON email_template_commands
    BEGIN SELECT RAISE(ABORT, 'email template command receipts are immutable'); END`,
  `CREATE TRIGGER email_template_commands_immutable_delete
    BEFORE DELETE ON email_template_commands
    BEGIN SELECT RAISE(ABORT, 'email template command receipts are immutable'); END`,
  `CREATE TRIGGER sender_identities_initial_state_guard
    BEFORE INSERT ON sender_identities
    WHEN NEW.version <> 0 OR NEW.archived_at IS NOT NULL OR NEW.is_default <> 0
    BEGIN SELECT RAISE(ABORT, 'sender identity must begin active and non-default at version zero'); END`,
  `CREATE TRIGGER sender_identities_binding_immutable
    BEFORE UPDATE OF id, email, provider, provider_identity, created_by_user_id, created_at
    ON sender_identities
    WHEN OLD.id IS NOT NEW.id OR OLD.email IS NOT NEW.email
      OR OLD.provider IS NOT NEW.provider
      OR OLD.provider_identity IS NOT NEW.provider_identity
      OR OLD.created_by_user_id IS NOT NEW.created_by_user_id
      OR OLD.created_at IS NOT NEW.created_at
    BEGIN SELECT RAISE(ABORT, 'sender identity provider binding is immutable'); END`,
  `CREATE TRIGGER sender_identities_version_guard
    BEFORE UPDATE ON sender_identities
    WHEN NEW.id IS OLD.id AND NEW.email IS OLD.email
      AND NEW.provider IS OLD.provider
      AND NEW.provider_identity IS OLD.provider_identity
      AND NEW.created_by_user_id IS OLD.created_by_user_id
      AND NEW.created_at IS OLD.created_at
      AND NEW.version <> OLD.version + 1
    BEGIN SELECT RAISE(ABORT, 'sender identity version must advance exactly one'); END`,
  `CREATE TRIGGER sender_identities_archive_one_way
    BEFORE UPDATE OF archived_at ON sender_identities
    WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NOT OLD.archived_at
    BEGIN SELECT RAISE(ABORT, 'sender identity archive state is immutable'); END`,
  `CREATE TRIGGER sender_identities_no_delete
    BEFORE DELETE ON sender_identities
    BEGIN SELECT RAISE(ABORT, 'sender identities must be archived, not deleted'); END`,
  `CREATE TRIGGER sender_identity_evidence_sequence_guard
    BEFORE INSERT ON sender_identity_evidence
    WHEN NEW.evidence_version <> COALESCE((
      SELECT max(evidence_version) + 1 FROM sender_identity_evidence
      WHERE sender_identity_id = NEW.sender_identity_id
    ), 1)
    BEGIN SELECT RAISE(ABORT, 'sender identity evidence is not the next observation'); END`,
  `CREATE TRIGGER sender_identity_evidence_provider_guard
    BEFORE INSERT ON sender_identity_evidence
    WHEN NOT EXISTS (
      SELECT 1 FROM sender_identities identity
      WHERE identity.id = NEW.sender_identity_id
        AND (
          (identity.provider = 'ses' AND NEW.source = 'provider_api')
          OR (
            identity.provider = 'smtp'
            AND NEW.source = 'deployment_config'
            AND lower(trim(identity.provider_identity)) = identity.email
          )
        )
    )
    BEGIN SELECT RAISE(ABORT, 'sender evidence source does not match provider binding'); END`,
  `CREATE TRIGGER sender_identity_evidence_immutable_update
    BEFORE UPDATE ON sender_identity_evidence
    BEGIN SELECT RAISE(ABORT, 'sender identity evidence is immutable'); END`,
  `CREATE TRIGGER sender_identity_evidence_immutable_delete
    BEFORE DELETE ON sender_identity_evidence
    BEGIN SELECT RAISE(ABORT, 'sender identity evidence is immutable'); END`,
  `CREATE TRIGGER sender_identity_commands_immutable_update
    BEFORE UPDATE ON sender_identity_commands
    BEGIN SELECT RAISE(ABORT, 'sender identity command receipts are immutable'); END`,
  `CREATE TRIGGER sender_identity_commands_immutable_delete
    BEFORE DELETE ON sender_identity_commands
    BEGIN SELECT RAISE(ABORT, 'sender identity command receipts are immutable'); END`,
  `CREATE TRIGGER email_test_send_commands_transition_guard
    BEFORE UPDATE ON email_test_send_commands
    WHEN OLD.status <> 'pending'
      OR NEW.command_id IS NOT OLD.command_id
      OR NEW.sender_identity_id IS NOT OLD.sender_identity_id
      OR NEW.template_kind IS NOT OLD.template_kind
      OR NEW.template_version IS NOT OLD.template_version
      OR NEW.actor_user_id IS NOT OLD.actor_user_id
      OR NEW.input_fingerprint IS NOT OLD.input_fingerprint
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.status NOT IN ('completed','failed')
    BEGIN SELECT RAISE(ABORT, 'email test-send command transition is invalid'); END`,
  `CREATE TRIGGER email_test_send_commands_immutable_delete
    BEFORE DELETE ON email_test_send_commands
    BEGIN SELECT RAISE(ABORT, 'email test-send command receipts are immutable'); END`,
  `CREATE TRIGGER sender_identity_default_verification_insert_guard
    BEFORE INSERT ON sender_identities WHEN NEW.is_default = 1
    BEGIN SELECT RAISE(ABORT, 'an unverified sender identity cannot be default'); END`,
  `CREATE TRIGGER sender_identity_default_verification_update_guard
    BEFORE UPDATE OF is_default ON sender_identities
    WHEN NEW.is_default = 1 AND NOT EXISTS (
      SELECT 1 FROM sender_identity_evidence evidence
      WHERE evidence.sender_identity_id = NEW.id
        AND evidence.evidence_version = (
          SELECT max(latest.evidence_version) FROM sender_identity_evidence latest
          WHERE latest.sender_identity_id = NEW.id
        )
        AND (
          (
            NEW.provider = 'ses'
            AND evidence.source = 'provider_api'
            AND evidence.verification_status = 'verified'
            AND (
              (evidence.identity_kind = 'email_address'
                AND lower(trim(NEW.provider_identity)) = NEW.email)
              OR (evidence.identity_kind = 'domain'
                AND lower(trim(NEW.provider_identity)) =
                  substr(NEW.email, instr(NEW.email, '@') + 1))
            )
            AND (
              evidence.dkim_status = 'verified'
              OR (
                evidence.mail_from_status = 'verified'
                AND evidence.mail_from_domain IS NOT NULL
                AND (
                  evidence.mail_from_domain = substr(NEW.email, instr(NEW.email, '@') + 1)
                  OR evidence.mail_from_domain LIKE
                    '%.' || substr(NEW.email, instr(NEW.email, '@') + 1)
                )
              )
            )
          )
          OR (
            NEW.provider = 'smtp'
            AND evidence.source = 'deployment_config'
            AND evidence.verification_status = 'operator_configured'
            AND evidence.identity_kind = 'email_address'
            AND evidence.dkim_status = 'not_applicable'
            AND evidence.mail_from_domain IS NULL
            AND evidence.mail_from_status = 'not_configured'
            AND lower(trim(NEW.provider_identity)) = NEW.email
          )
        )
    )
    BEGIN SELECT RAISE(ABORT, 'sender identity lacks trusted aligned provider evidence'); END`,
] as const
