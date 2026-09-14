/**
 * The Wise connection, assembled (issue 543).
 *
 * This is the app-token shape. An earlier pass built the OAuth one, where each
 * contractor authorised their own Wise account, and it is gone: the two answer
 * different questions and only one of them is the product. OAuth needs an app
 * registered with Wise, a consent screen, and every contractor to hold a Wise
 * account and complete a flow. A token needs one value on the deployment, and
 * it authenticates as the business that is actually sending the money.
 *
 * What did not change is the rule underneath. A payout resolves to a stored
 * identifier that the provider gave us, never to a guess about somebody's email
 * address -- which is all of #421. Under OAuth that identifier was a profile
 * the contractor authorised. Here it is a Wise *recipient*: the destination the
 * contractor told us to pay, created at Wise, stored against them in
 * `user_payout_accounts`. Same rule, different provenance.
 *
 * Nothing here ever holds a bank account number. Wise will hand one over --
 * `accountSummary` is the full number despite its name -- and the client
 * deliberately does not carry it, so it cannot reach a row or a screen by way
 * of this module.
 */

import {
  choosePayingProfile,
  createWiseClient,
  type WiseContact,
  type WiseRecipient,
} from "./client.js";
import {
  parseWiseEvent,
  payoutOutcomeFor,
  verifyWiseSignature,
} from "./webhook.js";

export interface WiseConnectionStatus {
  /** The profile money is sent from. */
  readonly profileId: string;
  readonly profileName: string | null;
  /** How many people this profile can currently pay, our own accounts excluded. */
  readonly payableRecipients: number;
  /** Whether deliveries can be believed. False means the public key is unset. */
  readonly webhooksVerifiable: boolean;
}

export type WiseLinkRefusal =
  | "unknown_recipient"
  | "recipient_is_ours"
  | "recipient_inactive"
  | "already_linked"
  | "recipient_taken"
  | "unknown_user";

export type WiseLinkOutcome =
  | { outcome: "linked"; recipient: WiseRecipient }
  | { outcome: WiseLinkRefusal };

/**
 * Onboarding somebody the organisation has never paid.
 *
 * `created_not_linked` is its own outcome rather than an error because the
 * recipient really does exist at Wise by then. Reporting a plain failure would
 * leave a destination sitting in the account that nobody here knows about; this
 * names it, so the operator can link it from the list instead.
 */
export type WiseOnboardOutcome =
  | { outcome: "linked"; recipient: WiseRecipient }
  | { outcome: "created_not_linked"; recipient: WiseRecipient; refusal: WiseLinkRefusal }
  | { outcome: "already_linked" }
  | { outcome: "not_configured" };

/**
 * Somebody telling us where to pay them, in the one detail they have to share.
 *
 * `not_discoverable` is the ordinary refusal: a mistyped Wisetag, or a profile
 * whose owner has discoverability switched off. It is the person's to fix, and
 * it is not the same event as Wise being unreachable.
 */
export type WiseShareOutcome =
  | { outcome: "linked"; contact: WiseContact }
  | { outcome: "not_discoverable" }
  | { outcome: WiseLinkRefusal }
  | { outcome: "not_configured" };

/**
 * Where a person is paid, as a screen needs to show it.
 *
 * No identifier. A contact id is opaque and a recipient id is opaque, and
 * neither tells anybody anything they could check -- what a person needs to see
 * is that a destination exists, that Wise confirmed it, and when. The one thing
 * worth reading is the kind, because "we hold your Wise profile" and "we hold
 * an account somebody entered" are different promises.
 */
export interface WiseDestination {
  readonly id: number;
  readonly kind: "account" | "contact";
  readonly linkedAt: string;
  readonly linkedByUserId: number;
  readonly verifiedAt: string | null;
}

/** The payout log, as this runtime needs it. */
export interface WisePayoutAccountPort {
  listForUser(
    userId: number,
  ): Promise<
    readonly {
      id: number;
      provider: string;
      externalId: string;
      kind?: "account" | "contact";
      linkedAt?: string;
      linkedByUserId?: number;
      verifiedAt: string | null;
    }[]
  >;
  listForProvider(
    provider: "wise",
  ): Promise<readonly { id: number; userId: number; externalId: string }[]>;
  link(input: {
    userId: number;
    provider: "wise";
    externalId: string;
    /** Which id space `externalId` lives in. Absent means a recipient account. */
    kind?: "account" | "contact";
    linkedByUserId: number;
    now: string;
  }): Promise<
    | { outcome: "linked"; account: { id: number } }
    | { outcome: "already_linked" | "external_id_taken" | "unknown_user" }
  >;
  markVerified(id: number, now: string): Promise<unknown>;
  detach(id: number, now: string): Promise<boolean>;
}

/**
 * The delivery ledger and the transfer log.
 *
 * `claim` is first and is the arbiter: Wise retries anything it did not get a
 * 2xx for, and only the first caller for a delivery id may act.
 */
export interface WiseDeliveryPort {
  claim(input: {
    deliveryId: string;
    subscriptionId: string;
    eventType: string;
    transferId: string | null;
    currentState: string | null;
    occurredAt: string | null;
    now: string;
  }): Promise<{ claim: "fresh" } | { claim: "duplicate" }>;
  finish(deliveryId: string, now: string, skippedReason: string | null): Promise<void>;
  settleTransfer(input: {
    transferId: string;
    outcome: "sent" | "failed";
    failureReason: string | null;
    now: string;
  }): Promise<
    | { settled: "sent" | "failed"; transferId: string }
    | { settled: "none"; reason: string }
  >;
}

export interface WiseConfig {
  /** The organisation's own API token. Authenticates as us, and sends real money. */
  readonly token: string | undefined;
  /**
   * Which profile pays, where the token reaches more than one.
   *
   * Optional: a business profile is chosen when it is the only one of its kind.
   * Naming it is better -- an account with two business profiles is a question
   * this cannot answer, and guessing which balance to pay out of would be the
   * same class of mistake as matching a person by their email.
   */
  readonly profileId: string | undefined;
  /**
   * The PEM Wise signs deliveries with.
   *
   * No default and no fallback. Wise rotates it, and the sandbox that once
   * justified a compiled-in key has been decommissioned. Absent means webhook
   * deliveries are refused, because an unverifiable claim about money is not
   * one to act on because a value was missing.
   */
  readonly webhookPublicKey: string | undefined;
}

export interface WiseRuntimeOptions {
  readonly config: WiseConfig;
  readonly accounts: WisePayoutAccountPort;
  /** Absent where a deployment does not receive webhooks; the route is then not mounted. */
  readonly deliveries?: WiseDeliveryPort;
  readonly fetch?: typeof fetch;
  readonly now: () => Date;
}

const trimmed = (value: string | undefined): string | null => {
  const text = value?.trim();
  return text === undefined || text === "" ? null : text;
};

export interface WiseRuntime {
  /** Absent unless a delivery port was supplied and a key is configured. */
  readonly webhook?: {
    receiveWebhook(input: {
      payload: string;
      signature: string | null;
      deliveryId: string | null;
      isTest: boolean;
    }): Promise<{ accepted: boolean }>;
  };
  readonly service: {
    configured(): boolean;
    readStatus(): Promise<WiseConnectionStatus | null>;
    /** Everyone the profile can pay, our own accounts excluded. */
    listRecipients(): Promise<readonly WiseRecipient[]>;
    /** Points a person at the destination they told us to pay. */
    linkRecipient(input: {
      userId: number;
      recipientId: string;
      linkedByUserId: number;
    }): Promise<WiseLinkOutcome>;
    /**
     * Creates the destination and points a person at it, in one step.
     *
     * The contractor gives us the email address on their Wise account and
     * nothing else. Wise collects the bank details from them directly, so no
     * account number exists in this system to be logged, backed up or leaked.
     */
    onboardRecipient(input: {
      userId: number;
      email: string;
      legalName: string;
      currency: string;
      linkedByUserId: number;
    }): Promise<WiseOnboardOutcome>;
    /**
     * Points a person at their own Wise profile, found by what they shared.
     *
     * A Wisetag, or the email or phone on their Wise account. Nothing is
     * collected afterwards and no bank details pass through here: Wise already
     * holds theirs, and resolves the contact to an account when a payout is
     * quoted -- so the destination survives them changing bank, which a stored
     * account number would not.
     */
    shareWiseProfile(input: {
      userId: number;
      identifier: string;
      currency: string;
      linkedByUserId: number;
    }): Promise<WiseShareOutcome>;
    /** Where one person is currently paid, or nothing. */
    readDestination(userId: number): Promise<WiseDestination | null>;
    /**
     * Removes a person's own destination.
     *
     * Addressed by person rather than by row, so the question "may you do this"
     * has the same answer as "may you set it" -- and somebody who has just
     * typed a tag that resolved to the wrong person can undo it themselves.
     */
    detachFor(userId: number): Promise<boolean>;
    unlink(accountId: number): Promise<boolean>;
  };
}

const refusalFor = (
  outcome: "already_linked" | "external_id_taken" | "unknown_user",
): WiseLinkRefusal =>
  outcome === "external_id_taken"
    ? "recipient_taken"
    : outcome === "already_linked"
      ? "already_linked"
      : "unknown_user";

export const createWiseRuntime = (options: Readonly<WiseRuntimeOptions>): WiseRuntime => {
  const { config, accounts } = options;
  const token = trimmed(config.token);
  const configuredProfileId = trimmed(config.profileId);
  const webhookPublicKey = trimmed(config.webhookPublicKey);
  const deliveries = options.deliveries;
  const client =
    token === null
      ? null
      : createWiseClient({
          token,
          ...(options.fetch === undefined ? {} : { fetchImplementation: options.fetch }),
        });

  const instant = (): string => options.now().toISOString();

  /** The profile that pays, resolved once per call rather than cached. */
  const payingProfile = async () => {
    if (client === null) return null;
    return choosePayingProfile(await client.profiles(), configuredProfileId);
  };

  /**
   * Everyone we could pay.
   *
   * Our own accounts are filtered out. They are a real thing Wise returns --
   * the business's own balances are recipients too -- and offering one as a
   * contractor's payout destination would send money in a circle.
   */
  const payableRecipients = async (): Promise<readonly WiseRecipient[]> => {
    const profile = await payingProfile();
    if (client === null || profile === null) return [];
    return (await client.recipients(profile.id)).filter(
      (recipient) => !recipient.ownedByUs && recipient.active,
    );
  };

  const receiveWebhook = async (input: {
    payload: string;
    signature: string | null;
    deliveryId: string | null;
    isTest: boolean;
  }): Promise<{ accepted: boolean }> => {
    if (deliveries === undefined) return { accepted: false };

    /**
     * The subscription ping, answered before the key is required.
     *
     * This is the deadlock the first version created: the route refused to
     * exist without the signing key, and the key comes from a webhook page you
     * cannot finish without an endpoint that answers. A deployment could never
     * get from one state to the other.
     *
     * Answering it unverified is safe because a test does nothing. Nothing is
     * parsed, nothing is claimed, nothing is written -- the worst an attacker
     * achieves by setting the header is a 200 from an endpoint. Every path that
     * touches money is below this line and still requires the key.
     */
    if (input.isTest) {
      // Before a key exists, accepted unverified -- that is the whole of the
      // bootstrap, and a test does nothing whoever sent it.
      if (webhookPublicKey === null) return { accepted: true };
      // Once one exists, held to it like everything else, so a subscription
      // cannot be proved to a configured deployment by a forgery.
      return {
        accepted: await verifyWiseSignature({
          body: input.payload,
          signature: input.signature,
          publicKeyPem: webhookPublicKey,
        }),
      };
    }

    // Everything else is a claim about money, and an unverifiable claim is
    // refused. A deployment that has not configured the key can complete a
    // subscription and still not be told anything it would act on.
    if (webhookPublicKey === null) return { accepted: false };
    const verified = await verifyWiseSignature({
      body: input.payload,
      signature: input.signature,
      publicKeyPem: webhookPublicKey,
    });
    if (!verified) return { accepted: false };

    const event = parseWiseEvent(input.payload);
    // Signed by Wise and unreadable by us. Accepted, because a retry of
    // something we cannot parse will not parse the second time either.
    if (event === null) return { accepted: true };

    const now = instant();
    const transferId = event.kind === "transfer_state" ? event.transferId : null;
    const eventType =
      event.kind === "transfer_state" ? "transfers#state-change" : event.eventType;
    // A delivery with no id of its own is keyed on the event's own identity,
    // which is stable across a retry for the same reason: a retry is the same
    // event again.
    const deliveryId =
      trimmed(input.deliveryId ?? undefined) ??
      [
        event.subscriptionId,
        eventType,
        transferId ?? "-",
        event.kind === "transfer_state" ? event.currentState : "-",
        event.occurredAt ?? "-",
      ].join("|");

    const claimed = await deliveries.claim({
      deliveryId,
      subscriptionId: event.subscriptionId,
      eventType,
      transferId,
      currentState: event.kind === "transfer_state" ? event.currentState : null,
      occurredAt: event.occurredAt,
      now,
    });
    // Told already. The right answer to a retry is 2xx and no further work.
    if (claimed.claim === "duplicate") return { accepted: true };

    if (event.kind !== "transfer_state") {
      await deliveries.finish(deliveryId, now, `event type ${event.eventType} is not acted on`);
      return { accepted: true };
    }

    const outcome = payoutOutcomeFor(event.currentState);
    if (outcome === null) {
      // In flight. Writing 'sent' here would mark money as moved while it is
      // still reversible, and a sent row cannot be corrected afterwards.
      await deliveries.finish(deliveryId, now, `state ${event.currentState} is not final`);
      return { accepted: true };
    }

    const settlement = await deliveries.settleTransfer({
      transferId: event.transferId,
      outcome,
      failureReason: outcome === "failed" ? `wise reported ${event.currentState}` : null,
      now,
    });
    await deliveries.finish(
      deliveryId,
      now,
      settlement.settled === "none" ? settlement.reason : null,
    );
    return { accepted: true };
  };

  return {
    // Mounted wherever deliveries can be recorded, key or no key. Without one
    // it answers the subscription ping and refuses everything else, which is
    // what lets a deployment get the key in the first place.
    ...(deliveries === undefined ? {} : { webhook: { receiveWebhook } }),
    service: {
      configured: () => token !== null,

      readStatus: async () => {
        const profile = await payingProfile();
        if (profile === null) return null;
        return {
          profileId: profile.id,
          profileName: profile.name,
          payableRecipients: (await payableRecipients()).length,
          webhooksVerifiable: webhookPublicKey !== null,
        };
      },

      listRecipients: payableRecipients,

      /**
       * Links a person to a destination, and records that Wise confirmed it.
       *
       * The recipient is read back from Wise rather than taken on trust from
       * the request. That read is what `verified_at` means: the provider itself
       * says this identifier resolves, which is the difference between a payout
       * destination and a claim somebody typed.
       */
      linkRecipient: async ({ userId, recipientId, linkedByUserId }) => {
        const recipients = await payableRecipients();
        const wanted = recipientId.trim();
        const recipient = recipients.find((candidate) => candidate.id === wanted);
        if (recipient === undefined) {
          // Either it does not exist, or it is one of ours, or it is closed.
          // Told apart so an operator is sent to the right place rather than
          // hunting a recipient that is sitting there deactivated.
          const all =
            client === null ? [] : await (async () => {
              const profile = await payingProfile();
              return profile === null ? [] : client.recipients(profile.id);
            })();
          const known = all.find((candidate) => candidate.id === wanted);
          if (known === undefined) return { outcome: "unknown_recipient" };
          return { outcome: known.ownedByUs ? "recipient_is_ours" : "recipient_inactive" };
        }

        const now = instant();
        const linked = await accounts.link({
          userId,
          provider: "wise",
          externalId: recipient.id,
          linkedByUserId,
          now,
        });
        if (linked.outcome !== "linked") return { outcome: refusalFor(linked.outcome) };
        await accounts.markVerified(linked.account.id, now);
        return { outcome: "linked", recipient };
      },

      onboardRecipient: async ({ userId, email, legalName, currency, linkedByUserId }) => {
        const profile = await payingProfile();
        if (client === null || profile === null) return { outcome: "not_configured" };

        // Asked before anything is created at Wise. A second recipient for
        // somebody who already has one is a destination nobody will ever pay,
        // and it cannot be deleted from here once it exists.
        const existing = await accounts.listForUser(userId);
        if (existing.some((account) => account.provider === "wise")) {
          return { outcome: "already_linked" };
        }

        const recipient = await client.createEmailRecipient({
          profileId: profile.id,
          email,
          legalName,
          currency,
        });
        const now = instant();
        const linked = await accounts.link({
          userId,
          provider: "wise",
          externalId: recipient.id,
          linkedByUserId,
          now,
        });
        if (linked.outcome !== "linked") {
          return { outcome: "created_not_linked", recipient, refusal: refusalFor(linked.outcome) };
        }
        // Wise made it, so Wise confirms it resolves; that is what verified
        // means here, exactly as it does for a recipient linked from the list.
        await accounts.markVerified(linked.account.id, now);
        return { outcome: "linked", recipient };
      },

      shareWiseProfile: async ({ userId, identifier, currency, linkedByUserId }) => {
        const profile = await payingProfile();
        if (client === null || profile === null) return { outcome: "not_configured" };

        // Asked before Wise is, because a second destination for somebody who
        // already has one is the question we can answer without a round trip.
        const existing = await accounts.listForUser(userId);
        if (existing.some((account) => account.provider === "wise")) {
          return { outcome: "already_linked" };
        }

        const found = await client.findContact({
          profileId: profile.id,
          identifier,
          targetCurrency: currency,
        });
        if (found.outcome !== "found") return { outcome: "not_discoverable" };

        const now = instant();
        const linked = await accounts.link({
          userId,
          provider: "wise",
          externalId: found.contact.id,
          // A contact id, not a recipient account id. They are different id
          // spaces and telling them apart by shape is a guess with a payout
          // attached to it.
          kind: "contact",
          linkedByUserId,
          now,
        });
        if (linked.outcome !== "linked") return { outcome: refusalFor(linked.outcome) };
        // Wise resolved the identifier to a profile, so the id is the
        // provider's own fact rather than a claim somebody typed -- which is
        // exactly what verified means everywhere else in this store.
        await accounts.markVerified(linked.account.id, now);
        return { outcome: "linked", contact: found.contact };
      },

      readDestination: async (userId) => {
        const mine = (await accounts.listForUser(userId)).find(
          (account) => account.provider === "wise",
        );
        if (mine === undefined) return null;
        return {
          id: mine.id,
          kind: mine.kind ?? "account",
          linkedAt: mine.linkedAt ?? "",
          linkedByUserId: mine.linkedByUserId ?? 0,
          verifiedAt: mine.verifiedAt,
        };
      },

      detachFor: async (userId) => {
        const mine = (await accounts.listForUser(userId)).find(
          (account) => account.provider === "wise",
        );
        return mine === undefined ? false : accounts.detach(mine.id, instant());
      },

      unlink: async (accountId) => accounts.detach(accountId, instant()),
    },
  };
};
