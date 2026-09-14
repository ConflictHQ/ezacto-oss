// Which id space a payout destination's external id lives in (#421, #543).
//
// 0042 stored "the provider's own identifier, verbatim" and that is still the
// rule. What it did not anticipate is that one provider can hand out more than
// one kind of identifier, and Wise hands out two:
//
//   - a recipient account id, which names bank details somebody gave us;
//   - a contact id, which names a discoverable Wise profile found by its
//     Wisetag, email or phone, and which Wise resolves to an account at the
//     moment a payout is quoted.
//
// The second is what a contractor can share without sending anybody their bank
// details, and it is the one that survives them changing bank: the Wisetag is
// stable while the account behind it is not. Both are opaque strings, and a
// system that has to guess which is which from its shape will eventually guess
// wrong -- with a payout attached to the guess. So the kind is recorded.
//
// The unique index from 0042 is unchanged and still means one current Wise
// destination per person, whichever kind it is. Somebody holding a contact and
// a recipient account at once would be two answers to "where does their money
// go", and there is no reading of that which is safe.

export const payoutDestinationKindMigration = [
  // 'account' for everything that exists, because everything that exists is a
  // provider account id -- Deel's, or a Wise recipient's.
  `ALTER TABLE user_payout_accounts
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'account'
    CHECK (kind IN ('account', 'contact'))`,

  // The kind says how to read the external id, so it is part of the identity
  // the 0042 trigger holds still. Recreated rather than added alongside: two
  // triggers on the same columns is two places to look when one of them fires.
  `DROP TRIGGER IF EXISTS user_payout_accounts_identity_immutable`,
  `CREATE TRIGGER user_payout_accounts_identity_immutable
    BEFORE UPDATE OF user_id, provider, external_id, kind ON user_payout_accounts
    WHEN OLD.user_id IS NOT NEW.user_id
      OR OLD.provider IS NOT NEW.provider
      OR OLD.external_id IS NOT NEW.external_id
      OR OLD.kind IS NOT NEW.kind
    BEGIN SELECT RAISE(ABORT, 'a payout account identity is immutable'); END`,

  // Only Wise has contacts. A Deel row claiming to hold one would be an id
  // nothing can resolve, discovered at the moment somebody is owed money.
  `CREATE TRIGGER user_payout_accounts_contact_is_wise
    BEFORE INSERT ON user_payout_accounts
    WHEN NEW.kind = 'contact' AND NEW.provider <> 'wise'
    BEGIN SELECT RAISE(ABORT, 'only Wise destinations can be a contact'); END`,
] as const
