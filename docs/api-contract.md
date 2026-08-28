# Native API chassis

`@ezacto/api` owns the runtime-portable Hono chassis mounted at `/api/v1` by both
Worker and container entries. Resource stories add routes through its installer;
they do not replace the error, pagination, request-id, or serialization boundaries.

## Errors and request ids

Every response carries a server-generated `x-request-id`. Incoming values are not
trusted or reflected. Every error response is JSON with one stable shape:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "The request contains invalid fields.",
    "fields": [
      { "field": "name", "code": "required", "message": "name is required" }
    ]
  },
  "request_id": "11111111-2222-3333-4444-555555555555"
}
```

`error.code` and each field code are lowercase machine identifiers. `fields` is
always an array and every `422` has at least one entry. All `5xx` failures—including
deliberately raised ones—use the generic `internal_error` body; exception text is
never placed on the wire. Errors are never cached.

JSON readers enforce a byte ceiling while consuming the stream (1 MiB by default),
even if `Content-Length` is absent or falsely small. Oversized bodies receive the
same envelope with `413 payload_too_large`.

## Cursor pages

Lists accept `per_page` (`1..200`, default `50`) and an opaque `cursor`. A page is:

```json
{
  "data": [],
  "links": { "self": "/api/v1/things", "next": null },
  "page": { "per_page": 50, "next_cursor": null }
}
```

The first request captures the collection's maximum SQLite row id. Every later page
uses the cursor's same high-water id and an exclusive last-seen id, so native
concurrent inserts cannot move or extend the traversal. Cursors are versioned,
HMAC-authenticated with a server-owned key of at least 32 bytes, and bound to the
endpoint, non-pagination filters, and page size. Re-encoding or replaying a cursor in
another collection scope is rejected. Clients follow `links.next`; they do not
construct or modify cursors.

Every returned record passes through the supplied serializer before entering
`data`. Permission and money-field redaction extend that seam rather than being
implemented ad hoc in routes.

The contract suite dispatches the same fixture handlers through a real Node HTTP
server adapter and a Miniflare/workerd isolate. In-process Hono tests remain unit
tests and are not treated as proof of runtime parity.
