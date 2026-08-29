# Attachment storage contract

This is the physical persistence contract for
[ezacto-oss #122](https://github.com/ConflictHQ/ezacto-oss/issues/122). It
implements domain model §2.13, feature F4's static slice, D17, migration spec
§4, and DV-16. Generated-report policy remains downstream of F2 + F6; HTTP
upload/list/download belongs to the `/api/v1` money-resource story; R2 and disk
placement remain owned by D17.

## Binary identity and logical metadata

`file_objects` is immutable content identity. `content_hash` is lowercase,
unprefixed SHA-256 hex, which is the same representation emitted by the migration
snapshot manifest. A hash identifies one `file_key`, byte size, and content type.
An existing hash is reused only when all four values agree; conflicting metadata
aborts the whole attachment write.

`attachments` is the logical record: it supplies the user-visible name, nullable
uploader, and timestamps while referring to one file object. Multiple logical
records may therefore preserve different names and owners for the same bytes.

## Exactly one real owner

Ownership is represented by five real-FK tables:

- `invoice_attachments`
- `recurring_invoice_attachments`
- `estimate_attachments`
- `expense_attachments`
- `project_attachments`

The logical row carries five internal link guards, exactly one of which must equal
the logical attachment id. Each guard is a deferred FK back to its matching join
row. Matching triggers reject a join in any other table. The result is a
commit-time invariant: zero owners, multiple owners, a missing parent, and an
unmatched join are all rejected, including raw SQL and conflict-clause writes.
There is no `owner_type`, generic `owner_id`, native `receipts` table,
`expense.receipt_id`, or attachment placeholder on an owner table.

`createAttachmentStore()` executes file-object convergence, logical attachment
creation, and the one owner join in one local transaction or one predetermined D1
batch. A failure rolls every new row back. Reads are owner-specific and always
scope by both the real parent relation and (for content reads) the logical
attachment id.

## Static recurring policy v1

`recurring_invoices.attachment_policy` is nullable. Its only accepted v1 value is:

```json
{
  "schema_version": 1,
  "type": "static",
  "attachment_ids": [101, 102]
}
```

The object is closed and versioned: unknown keys, duplicate keys, duplicate ids,
non-integer ids, unknown versions, and empty lists fail. Every id must identify an
attachment already owned by that same complete recurring definition. A referenced
logical attachment cannot be removed until the policy is changed or cleared.
`generated_report` and every other policy variant are deliberately rejected until
the later F2 + F6 story owns generation semantics.

## Harvest receipt mapping

The extractor's Harvest `receipt` vocabulary maps as follows:

| Harvest/snapshot value | Native value |
| --- | --- |
| downloaded SHA-256 | `file_objects.content_hash` |
| `receipts/<hash>.<ext>` | `file_objects.file_key` |
| verified downloaded bytes | `file_objects.byte_size` |
| `receipt.content_type` | `file_objects.content_type` |
| `receipt.file_name` | `attachments.name` |
| source expense | `expense_attachments.expense_id` |

The downloaded byte count must equal Harvest's declared `file_size` before load.
The sanitized golden fixture exercises that verification and round-trips the
content identity through an expense-owned logical attachment.
