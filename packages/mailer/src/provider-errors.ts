const terminalReasonPattern = /^[a-z][a-z0-9_]*(?::[A-Z][A-Z0-9_]*)?$/;

/**
 * A provider outcome that cannot succeed on retry without external state
 * changing. The reason is safe, bounded metadata for the durable delivery log;
 * provider response bodies and recipient addresses never enter it.
 */
export class EmailProviderTerminalError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    if (
      typeof reason !== "string" ||
      reason.length > 128 ||
      !terminalReasonPattern.test(reason)
    ) {
      throw new TypeError("terminal email provider reason is invalid");
    }
    super("email provider rejected delivery permanently");
    this.name = "EmailProviderTerminalError";
    this.reason = reason;
  }
}
