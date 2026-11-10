/** No follow-up has been recorded or enqueued; the source invoice delivery
 * remains pending. The outbox may defer this specific subscriber safely. */
export class FollowUpDeliveryDeferred extends Error {
  constructor() { super('invoice delivery is not ready for follow-up') }
}
