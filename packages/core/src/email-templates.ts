export const emailTemplateKinds = [
  "invoice",
  "reminder",
  "thank_you",
  "auth_email_verification",
  "auth_password_reset",
] as const;

export type EmailTemplateKind = (typeof emailTemplateKinds)[number];

export interface EmailTemplateVariableDefinition {
  name: string;
  token: `%${string}%`;
  description: string;
  kinds: readonly EmailTemplateKind[];
  compatibility: "harvest" | "native";
}

const invoiceKinds = [
  "invoice",
  "reminder",
  "thank_you",
] as const satisfies readonly EmailTemplateKind[];

const everyKind = [...emailTemplateKinds] as readonly EmailTemplateKind[];

/**
 * The closed, UI-discoverable vocabulary. `harvest` marks only variables
 * evidenced in the captured Harvest account; native additions do not imply
 * undocumented wire or rendering parity.
 */
export const emailTemplateVariables = [
  {
    name: "company_name",
    token: "%company_name%",
    description: "Organization name",
    kinds: everyKind,
    compatibility: "harvest",
  },
  {
    name: "invoice_id",
    token: "%invoice_id%",
    description: "Invoice numeric identifier",
    kinds: invoiceKinds,
    compatibility: "harvest",
  },
  {
    name: "invoice_issue_month_name",
    token: "%invoice_issue_month_name%",
    description: "Invoice issue month name",
    kinds: invoiceKinds,
    compatibility: "harvest",
  },
  {
    name: "invoice_issue_year",
    token: "%invoice_issue_year%",
    description: "Invoice issue year",
    kinds: invoiceKinds,
    compatibility: "harvest",
  },
  {
    name: "invoice_number",
    token: "%invoice_number%",
    description: "Invoice display number",
    kinds: invoiceKinds,
    compatibility: "native",
  },
  {
    name: "invoice_subject",
    token: "%invoice_subject%",
    description: "Invoice subject",
    kinds: invoiceKinds,
    compatibility: "native",
  },
  {
    name: "invoice_amount",
    token: "%invoice_amount%",
    description: "Formatted invoice total",
    kinds: invoiceKinds,
    compatibility: "native",
  },
  {
    name: "invoice_currency",
    token: "%invoice_currency%",
    description: "Invoice ISO 4217 currency code",
    kinds: invoiceKinds,
    compatibility: "native",
  },
  {
    name: "invoice_issue_date",
    token: "%invoice_issue_date%",
    description: "Invoice issue date",
    kinds: invoiceKinds,
    compatibility: "native",
  },
  {
    name: "invoice_due_date",
    token: "%invoice_due_date%",
    description: "Invoice due date",
    kinds: invoiceKinds,
    compatibility: "native",
  },
  {
    name: "invoice_paid_date",
    token: "%invoice_paid_date%",
    description: "Invoice payment date",
    kinds: ["thank_you"],
    compatibility: "native",
  },
  {
    name: "client_name",
    token: "%client_name%",
    description: "Billable client name",
    kinds: invoiceKinds,
    compatibility: "native",
  },
  {
    /**
     * A block, not a scalar: it carries its own plain-text and HTML renderings
     * so the lines survive an HTML template as a table instead of arriving as
     * one escaped blob.
     */
    name: "invoice_line_items",
    token: "%invoice_line_items%",
    description: "Invoice line items, quantity, rate, and amount",
    kinds: invoiceKinds,
    compatibility: "native",
  },
  {
    name: "invoice_payment_url",
    token: "%invoice_payment_url%",
    description: "Where the client pays this invoice online, if a link exists",
    kinds: invoiceKinds,
    // Native rather than harvest: Harvest's own invoice email carried a "View
    // invoice" link to its client portal, not a checkout URL. This is ezacto's
    // own, and a template using it is one Harvest never had.
    compatibility: "native",
  },
  {
    name: "action_url",
    token: "%action_url%",
    description: "One-time authentication action URL",
    kinds: ["auth_email_verification", "auth_password_reset"],
    compatibility: "native",
  },
  {
    name: "expires_at",
    token: "%expires_at%",
    description: "Authentication action expiry timestamp",
    kinds: ["auth_email_verification", "auth_password_reset"],
    compatibility: "native",
  },
] as const satisfies readonly EmailTemplateVariableDefinition[];

export type EmailTemplateVariableName =
  (typeof emailTemplateVariables)[number]["name"];

/**
 * A value that is a passage rather than a word. The two renderings are built
 * together by the producer, because escaping a plain-text block into an HTML
 * template yields a wall of text and interpolating markup into a plain-text
 * body yields tags -- the same content has to be authored twice or it is wrong
 * in one of the two bodies every message carries. `html` is markup and is
 * emitted verbatim, so whoever builds one owes the escaping (see
 * `escapeEmailHtml`).
 */
export interface EmailTemplateBlockValue {
  readonly text: string;
  readonly html: string;
}

export type EmailTemplateVariableValue = string | EmailTemplateBlockValue;

export type EmailTemplateVariableValues = Partial<
  Readonly<Record<EmailTemplateVariableName, EmailTemplateVariableValue>>
>;

export type UnknownEmailTemplateVariablePolicy = "error" | "literal";

export type EmailTemplateVariableErrorCode =
  | "unknown_variable"
  | "variable_not_allowed"
  | "missing_variable";

export class EmailTemplateVariableError extends Error {
  constructor(
    readonly code: EmailTemplateVariableErrorCode,
    readonly variable: string,
    readonly kind: EmailTemplateKind,
  ) {
    const reason =
      code === "unknown_variable"
        ? "is not in the supported vocabulary"
        : code === "variable_not_allowed"
          ? `is not available to ${kind} templates`
          : "has no value for this message";
    super(`Template variable %${variable}% ${reason}.`);
    this.name = "EmailTemplateVariableError";
  }
}

const definitions = new Map<string, EmailTemplateVariableDefinition>(
  emailTemplateVariables.map((definition) => [definition.name, definition]),
);

const variablePattern = /%([A-Za-z][A-Za-z0-9_]*)%/gu;

const assertKind: (kind: string) => asserts kind is EmailTemplateKind = (kind) => {
  if (!(emailTemplateKinds as readonly string[]).includes(kind)) {
    throw new TypeError("email template kind is unsupported");
  }
};

/**
 * The one escaping rule for email bodies. Exported so a producer of an
 * `EmailTemplateBlockValue` escapes exactly what interpolation would have.
 */
export const escapeEmailHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const variablesForEmailTemplate = (
  kind: EmailTemplateKind,
): readonly EmailTemplateVariableDefinition[] => {
  assertKind(kind);
  return emailTemplateVariables.filter((definition) =>
    definition.kinds.includes(kind as never),
  );
};

export const inspectEmailTemplateVariables = (
  kind: EmailTemplateKind,
  source: string,
): readonly EmailTemplateVariableError[] => {
  assertKind(kind);
  if (typeof source !== "string") throw new TypeError("template source must be a string");
  const failures: EmailTemplateVariableError[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(variablePattern)) {
    const name = match[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    const definition = definitions.get(name);
    if (definition === undefined) {
      failures.push(new EmailTemplateVariableError("unknown_variable", name, kind));
    } else if (!definition.kinds.includes(kind)) {
      failures.push(
        new EmailTemplateVariableError("variable_not_allowed", name, kind),
      );
    }
  }
  return failures;
};

const isBlockValue = (
  value: EmailTemplateVariableValue,
): value is EmailTemplateBlockValue =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as EmailTemplateBlockValue).text === "string" &&
  typeof (value as EmailTemplateBlockValue).html === "string";

export const interpolateEmailTemplate = (
  kind: EmailTemplateKind,
  source: string,
  values: EmailTemplateVariableValues,
  options: Readonly<{
    unknownVariable?: UnknownEmailTemplateVariablePolicy;
    output?: "plain" | "html";
  }> = {},
): string => {
  assertKind(kind);
  if (typeof source !== "string") throw new TypeError("template source must be a string");
  const unknownVariable = options.unknownVariable ?? "error";
  if (unknownVariable !== "error" && unknownVariable !== "literal") {
    throw new TypeError("unknown template variable policy is unsupported");
  }
  const output = options.output ?? "plain";
  if (output !== "plain" && output !== "html") {
    throw new TypeError("template output is unsupported");
  }
  return source.replace(variablePattern, (token, name: string) => {
    const definition = definitions.get(name);
    if (definition === undefined) {
      if (unknownVariable === "literal") return token;
      throw new EmailTemplateVariableError("unknown_variable", name, kind);
    }
    if (!definition.kinds.includes(kind)) {
      if (unknownVariable === "literal") return token;
      throw new EmailTemplateVariableError("variable_not_allowed", name, kind);
    }
    const value = values[name as EmailTemplateVariableName];
    if (value === undefined) {
      throw new EmailTemplateVariableError("missing_variable", name, kind);
    }
    if (isBlockValue(value)) {
      // Already rendered for both bodies by whoever supplied it, markup
      // included, so escaping here would print the tags.
      return output === "html" ? value.html : value.text;
    }
    if (typeof value !== "string") {
      throw new TypeError(`template variable ${name} must be a string`);
    }
    return output === "html" ? escapeEmailHtml(value) : value;
  });
};
