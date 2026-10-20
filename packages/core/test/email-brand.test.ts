import { describe, expect, it } from "vitest";
import { brandEmailHtml, emailBrandHeader, type EmailBrand } from "../src/email-brand.js";

const brand: EmailBrand = {
  accentColor: "#DB394C",
  logoUrl: "https://time.example.com/brand/wordmark-light/abc123",
  name: "Acme & Sons",
};

describe("branded email header (#1011)", () => {
  it("[unit] renders the light wordmark by absolute URL and the accent rule", () => {
    const html = brandEmailHtml("<p>Hello</p>", brand);
    expect(html).toContain('src="https://time.example.com/brand/wordmark-light/abc123"');
    expect(html).toContain("border-bottom:4px solid #DB394C");
    expect(html.endsWith("<p>Hello</p>")).toBe(true);
    expect(html).not.toContain("data:");
  });

  it("[unit] escapes the company name used as alternative text", () => {
    expect(brandEmailHtml("<p>x</p>", { ...brand, name: 'A"><script>' })).not.toContain("<script>");
    expect(brandEmailHtml("<p>x</p>", brand)).toContain('alt="Acme &amp; Sons"');
  });

  it("[unit] returns the input byte for byte when no brand is set", () => {
    const html = "<!doctype html><html><body><p>Hello</p></body></html>";
    expect(brandEmailHtml(html, null)).toBe(html);
    expect(brandEmailHtml(html, { accentColor: null, logoUrl: null, name: "Acme" })).toBe(html);
  });

  it("[unit] never passes an unvalidated colour or a non-http logo into the markup", () => {
    const header = emailBrandHeader({
      accentColor: "red;background:url(x)",
      logoUrl: "javascript:alert(1)",
      name: "Acme",
    });
    expect(header).toBeNull();
    const accentOnly = emailBrandHeader({ ...brand, logoUrl: "data:image/png;base64,AAAA" });
    expect(accentOnly).not.toContain("<img");
    expect(accentOnly).toContain("#DB394C");
  });

  it("[unit] falls back to the company name as text when there is an accent but no logo", () => {
    const header = emailBrandHeader({ ...brand, logoUrl: null })!;
    expect(header).not.toContain("<img");
    expect(header).toContain("Acme &amp; Sons");
  });

  it("[unit] puts the header inside the body of a full document and is idempotent", () => {
    const html = '<!doctype html><html><body class="x"><p>Hello</p></body></html>';
    const branded = brandEmailHtml(html, brand);
    expect(branded.startsWith('<!doctype html><html><body class="x"><div data-ezacto-brand')).toBe(true);
    expect(brandEmailHtml(branded, brand)).toBe(branded);
  });
});
