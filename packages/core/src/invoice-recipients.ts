/**
 * The addresses an invoice email carries, checked the way every recipient row
 * in the schema is held (migration 0099). Pure, so the route that validates a
 * Send dialog and the store that saves a client's lists agree on what an
 * address is.
 */

export interface InvoiceAddress {
  readonly name: string;
  readonly email: string;
}

export interface InvoiceRecipientLists {
  readonly to: readonly InvoiceAddress[];
  readonly cc: readonly InvoiceAddress[];
}

export const invoiceEmailPattern = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u;

export class InvoiceAddressError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "InvoiceAddressError";
  }
}

/**
 * One list, normalized and checked. An address appearing twice is refused
 * rather than collapsed: a list that says the same thing twice was typed by
 * somebody who meant something else.
 */
export const normalizeInvoiceAddresses = (
  list: readonly InvoiceAddress[],
  field: string,
  maximum: number,
): InvoiceAddress[] => {
  if (!Array.isArray(list) || list.length > maximum) {
    throw new InvoiceAddressError(field, `${field} must list at most ${String(maximum)} addresses`);
  }
  const seen = new Set<string>();
  return list.map((entry, index) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.email !== "string" ||
      typeof entry.name !== "string"
    ) {
      throw new InvoiceAddressError(
        `${field}[${String(index)}]`,
        "each address needs a name and an email",
      );
    }
    const email = entry.email.normalize("NFC").trim().toLowerCase();
    const name = entry.name.normalize("NFC").trim();
    if (
      email.length > 254 ||
      !invoiceEmailPattern.test(email) ||
      name.length > 200 ||
      /\p{Cc}/u.test(name)
    ) {
      throw new InvoiceAddressError(
        `${field}[${String(index)}]`,
        `${email || "an address"} is not a valid email address`,
      );
    }
    if (seen.has(email)) {
      throw new InvoiceAddressError(`${field}[${String(index)}]`, `${email} is listed twice`);
    }
    seen.add(email);
    return { name, email };
  });
};

/**
 * Both lists together, with an address in one header at most: copied on a
 * message is not also addressed by it.
 */
export const normalizeInvoiceRecipientLists = (
  lists: InvoiceRecipientLists,
): InvoiceRecipientLists => {
  const to = normalizeInvoiceAddresses(lists.to, "to", 50);
  const cc = normalizeInvoiceAddresses(lists.cc, "cc", 50);
  const addressed = new Set(to.map(({ email }) => email));
  const both = cc.findIndex(({ email }) => addressed.has(email));
  if (both !== -1) {
    throw new InvoiceAddressError(`cc[${String(both)}]`, `${cc[both]!.email} is already in To`);
  }
  return { to, cc };
};

/**
 * The Cc an invoice email actually carries: what the sender chose, then the
 * organization's own mailboxes, then the sender themselves when they asked to
 * be copied -- each once, and never an address the message is already To.
 */
export const invoiceEmailCopies = (
  input: Readonly<{
    to: readonly InvoiceAddress[];
    cc: readonly InvoiceAddress[];
    alwaysCc: readonly InvoiceAddress[];
    sender: InvoiceAddress | null;
  }>,
): InvoiceAddress[] => {
  const seen = new Set(input.to.map(({ email }) => email.toLowerCase()));
  const copies: InvoiceAddress[] = [];
  for (const address of [
    ...input.cc,
    ...input.alwaysCc,
    ...(input.sender === null ? [] : [input.sender]),
  ]) {
    const email = address.email.trim().toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    copies.push({ name: address.name, email });
  }
  return copies;
};
