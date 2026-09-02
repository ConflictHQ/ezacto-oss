import { describe, expect, it } from "vitest";
import {
  emailTemplateVariables,
  inspectEmailTemplateVariables,
  interpolateEmailTemplate,
  variablesForEmailTemplate,
  EmailTemplateVariableError,
} from "../src/email-templates.js";

describe("email template variables", () => {
  it("[unit] renders the evidenced Harvest invoice vocabulary as a golden string", () => {
    const template =
      "Invoice #%invoice_id% from %company_name% — %invoice_issue_month_name% %invoice_issue_year%";
    expect(
      interpolateEmailTemplate("invoice", template, {
        invoice_id: "1305",
        company_name: "CONFLICT LLC",
        invoice_issue_month_name: "August",
        invoice_issue_year: "2026",
      }),
    ).toBe("Invoice #1305 from CONFLICT LLC — August 2026");
  });

  it("[unit] renders the complete native invoice vocabulary deterministically", () => {
    expect(
      interpolateEmailTemplate(
        "thank_you",
        [
          "%invoice_number%",
          "%invoice_subject%",
          "%invoice_amount%",
          "%invoice_currency%",
          "%invoice_issue_date%",
          "%invoice_due_date%",
          "%invoice_paid_date%",
          "%client_name%",
        ].join("|"),
        {
          invoice_number: "INV-0042",
          invoice_subject: "September support",
          invoice_amount: "$1,234.56",
          invoice_currency: "USD",
          invoice_issue_date: "2026-09-01",
          invoice_due_date: "2026-10-01",
          invoice_paid_date: "2026-09-18",
          client_name: "North Peak",
        },
      ),
    ).toBe(
      "INV-0042|September support|$1,234.56|USD|2026-09-01|2026-10-01|2026-09-18|North Peak",
    );
  });

  it("[unit] renders auth variables and escapes substitutions in HTML only", () => {
    const values = {
      company_name: "A & B <Studio>",
      action_url: "https://example.test/a?x=1&y=2",
      expires_at: "2026-09-02T12:00:00.000Z",
    };
    expect(
      interpolateEmailTemplate(
        "auth_email_verification",
        "%company_name%: %action_url% (%expires_at%)",
        values,
        { output: "html" },
      ),
    ).toBe(
      "A &amp; B &lt;Studio&gt;: https://example.test/a?x=1&amp;y=2 (2026-09-02T12:00:00.000Z)",
    );
    expect(
      interpolateEmailTemplate(
        "auth_email_verification",
        "%company_name%: %action_url%",
        values,
      ),
    ).toBe("A & B <Studio>: https://example.test/a?x=1&y=2");
  });

  it("[unit] makes the literal-versus-error compatibility policy explicit", () => {
    const imported = "%invoice_id% %future_harvest_variable%";
    expect(
      interpolateEmailTemplate(
        "invoice",
        imported,
        { invoice_id: "42" },
        { unknownVariable: "literal" },
      ),
    ).toBe("42 %future_harvest_variable%");
    expect(() =>
      interpolateEmailTemplate("invoice", imported, { invoice_id: "42" }),
    ).toThrowError(
      expect.objectContaining({
        name: "EmailTemplateVariableError",
        code: "unknown_variable",
        variable: "future_harvest_variable",
      }),
    );
    expect(() =>
      interpolateEmailTemplate("invoice", "%INVOICE_ID%", { invoice_id: "42" }),
    ).toThrow("%INVOICE_ID% is not in the supported vocabulary");
  });

  it("[unit] distinguishes unknown, disallowed, and missing variables", () => {
    expect(inspectEmailTemplateVariables("invoice", "%wat% %action_url%")).toMatchObject([
      { code: "unknown_variable", variable: "wat" },
      { code: "variable_not_allowed", variable: "action_url" },
    ]);
    expect(() =>
      interpolateEmailTemplate("invoice", "%company_name%", {}),
    ).toThrowError(
      expect.objectContaining({
        code: "missing_variable",
        variable: "company_name",
      }),
    );
  });

  it("[unit] exposes a closed reference vocabulary with honest compatibility labels", () => {
    expect(emailTemplateVariables).toHaveLength(14);
    expect(
      emailTemplateVariables
        .filter(({ compatibility }) => compatibility === "harvest")
        .map(({ token }) => token),
    ).toEqual([
      "%company_name%",
      "%invoice_id%",
      "%invoice_issue_month_name%",
      "%invoice_issue_year%",
    ]);
    expect(
      variablesForEmailTemplate("auth_password_reset").map(({ token }) => token),
    ).toEqual(["%company_name%", "%action_url%", "%expires_at%"]);
    expect(() => variablesForEmailTemplate("made_up" as never)).toThrow(TypeError);
  });

  it("[unit] preserves percent text that is not a variable token", () => {
    expect(
      interpolateEmailTemplate("invoice", "100% paid; %% and %42%", {}),
    ).toBe("100% paid; %% and %42%");
    expect(EmailTemplateVariableError).toBeTypeOf("function");
  });
});
