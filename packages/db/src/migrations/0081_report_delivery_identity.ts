/** Report brands and client-note visibility are delivery identity, not deployment theming (#55). */
export const reportDeliveryIdentityMigration = [
  `CREATE TABLE report_brands (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
    logo_url TEXT CHECK (logo_url IS NULL OR length(trim(logo_url)) BETWEEN 1 AND 2000),
    primary_color TEXT CHECK (primary_color IS NULL OR primary_color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
    accent_color TEXT CHECK (accent_color IS NULL OR accent_color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `ALTER TABLE clients ADD COLUMN report_brand_id INTEGER REFERENCES report_brands(id) ON DELETE RESTRICT`,
  `CREATE INDEX clients_report_brand_id ON clients(report_brand_id)`,
  `ALTER TABLE organizations ADD COLUMN report_notes_client_visible_default INTEGER NOT NULL DEFAULT 1
    CHECK (report_notes_client_visible_default IN (0,1))`,
  `ALTER TABLE time_entries ADD COLUMN client_visible INTEGER
    CHECK (client_visible IS NULL OR client_visible IN (0,1))`,
] as const
