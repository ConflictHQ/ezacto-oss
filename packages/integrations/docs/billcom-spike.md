# Bill.com API spike

Written spike, no code. D13 asks that Bill.com be estimated only after the auth,
sandbox, and AR/AP questions have answers, because the three of them decide
whether an adapter is a fortnight or a quarter. This is what the published API
documentation says as of 2026-09-08, what it leaves open, and what has to be
confirmed against a sandbox before anyone sizes the work.

Nothing here was verified against a live account: this repo has no Bill.com
credentials and the spike is deliberately not the place to acquire them.

## 1. Authentication

Two generations of API are documented at once, and which one we target changes
the shape of the adapter more than any other decision here.

**v2 (`api.bill.com/api/v2`)** is the mature one. It is a session API: a
`Login.json` call takes `userName`, `password`, `orgId` and a `devKey`, and
returns a `sessionId` that every later call carries. Requests are form-encoded
with a JSON `data` parameter rather than a JSON body. Consequences for us:

- The credential is a **user's password plus a developer key**, not a scoped
  machine token. That is a materially worse secret to hold than the Deel bearer
  token, and it is per-organization.
- Sessions expire, so the adapter needs a login/refresh path and has to treat a
  session expiry mid-run as an ordinary case rather than an error.
- The developer key is issued by Bill.com to an approved developer account.
  Approval is a lead time, not an afternoon.

**v3 (`gateway.prod.bill.com/connect/v3`)** is the newer surface and is
documented with OAuth-style application credentials and JSON bodies. It is the
one to want. What is not established from the documentation alone is whether v3
covers the AP objects we need at parity with v2, and whether a single-org
customer (us) can get v3 access without a partner agreement.

**To confirm in the sandbox:** which API version an ordinary (non-partner)
Bill.com organization can call; what the session lifetime is on v2; whether v3
credentials can be issued to a self-hosting ezacto operator, since an adapter
only a partner can use is not an adapter this repo can ship.

## 2. Sandbox

Bill.com documents a developer sandbox at a separate host
(`api-sandbox.bill.com` for v2). It is reachable only with a developer key, and
the sandbox organization is created by Bill.com rather than by us.

**To confirm:** how long sandbox provisioning takes; whether the sandbox can
hold a vendor with a payment method attached, since a payment adapter that
cannot be exercised end to end in a sandbox has to be tested in production with
real money, which we will not do; whether sandbox rate limits match production.

Until a sandbox organization exists, an adapter cannot be built the way the Deel
client in this package was built. That is the single biggest scheduling risk in
the estimate.

## 3. AR or AP

They are different products inside one API and we would be reaching for them for
opposite reasons.

- **AP (accounts payable)** — `Vendor`, `Bill`, `BillPay`, `SendPay`. This is
  paying contractors, and it is the half that overlaps the Deel work: the same
  monthly run, a different rail. A Bill.com AP adapter would consume the same
  payroll-address matching and the same transfer log this package already has,
  because the double-payment risk is identical.
- **AR (accounts receivable)** — `Customer`, `Invoice`, `ReceivedPay`. This is
  getting paid by clients, and it overlaps the invoice lane, not this one. The
  domain model already reserves `bill_com_checkout` and `bill_com_transfer` as
  payment-option vocabulary without claiming an adapter behind them.

**Recommendation:** if Bill.com is built, build **AP first**, because it is the
lane D13 actually needs and it reuses the matcher and the transfer log rather
than needing an invoice-side seam that does not exist yet. AR should be a
separate story with its own estimate, not a sub-task of this one.

**To confirm:** whether AP payment creation is idempotent by client-supplied
key. Deel is not, which is why this package keeps its own transfer log. If
Bill.com offers a real idempotency key, the AP adapter is meaningfully smaller
and safer than the Deel one.

## 4. What the estimate is blocked on

1. Developer key issued, and the answer to whether we target v2 or v3.
2. A sandbox organization that can hold a vendor with a payment method.
3. Whether AP payment creation takes an idempotency key.

Numbers 1 and 2 are lead time on Bill.com's side and should be started before
the story is sized. Number 3 changes the size of the story by roughly the amount
of work the transfer log in this package represents.
