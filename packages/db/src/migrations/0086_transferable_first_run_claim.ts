// Provenance: ezacto-oss issue 780; an abandoned first-run claim was permanent,
// and the owner invariant is why.

/**
 * `POST /auth/signup` claims an instance, and the claim was permanent. Where no
 * bootstrap token closes the route, anyone who signed up and never opened the
 * verification mail left an instance nobody else could ever claim: the real
 * operator's only route back was the database.
 *
 * Deleting the abandoned rows is not available and should not be. `users_first_
 * becomes_owner` writes `organization_owner` the moment the first user exists,
 * `organization_owner_cannot_delete` refuses every delete unconditionally, and
 * the `ON DELETE RESTRICT` then pins the user. A sweep does not do something
 * dangerous, it fails on a foreign key -- the schema holding its invariant.
 *
 * So the claim transfers in place instead. Organization 1 and user 1 keep their
 * identity and have their name, address and password rewritten for the new
 * claimant. "One owner, reassigned" describes what happened better than "no
 * owner, briefly", and the invariant stays true at every point.
 *
 * `auth_first_run_immutable` is the only thing that has to move: a transfer
 * mints a new claim nonce, which that trigger refused. It now admits exactly
 * that one case, and the condition it admits it under is the safety predicate
 * itself:
 *
 *   no address anywhere has ever been verified.
 *
 * That is stronger than "the token expired". A verified address is the only
 * route to a session, and a session is the only route to creating anything
 * else, so its absence proves nothing exists that the abandoned signup did not
 * write. Putting it in the trigger rather than at a call site means it cannot
 * be forgotten by a future caller: the database refuses the transfer itself.
 *
 * `created_at` stays immutable, and a completed claim stays untouchable.
 */
export const transferableFirstRunClaimMigration = [
  `DROP TRIGGER auth_first_run_immutable`,
  `CREATE TRIGGER auth_first_run_immutable BEFORE UPDATE ON auth_first_run
    WHEN OLD.created_at IS NOT NEW.created_at
      OR OLD.completed_at IS NOT NULL
      OR (
        OLD.claim_nonce IS NOT NEW.claim_nonce
        AND EXISTS (
          SELECT 1 FROM user_emails WHERE verified_at IS NOT NULL
        )
      )
    BEGIN SELECT RAISE(ABORT, 'first-run signup claim is immutable'); END`,
] as const
