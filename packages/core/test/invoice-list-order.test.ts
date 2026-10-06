import { describe, expect, it } from "vitest";
import {
  compareInvoiceListPositions,
  compareInvoiceNumbers,
  type InvoiceListPosition,
} from "../src/invoice-list-order.js";

const at = (issueDate: string, number: string, id: number): InvoiceListPosition => ({
  issueDate,
  number,
  id,
});

const listed = (positions: readonly InvoiceListPosition[]): string[] =>
  [...positions].sort(compareInvoiceListPositions).map((position) => position.number);

describe("the order the invoice list is read in", () => {
  it("[unit] puts the latest issue date first, whatever the id says", () => {
    // The shape that buried a paid invoice: the import numbered newest first,
    // so the newest import is id 1, and an invoice raised here took a large
    // hash-derived id. By id ascending the two newest sat at opposite ends.
    expect(
      listed([
        at("2026-03-30", "4021", 1),
        at("2026-02-28", "4020", 2),
        at("2026-04-01", "4022", 7_316_402_118_945_027),
        at("2026-01-31", "4019", 3),
      ]),
    ).toEqual(["4022", "4021", "4020", "4019"]);
  });

  it("[unit] compares numbers made of digits as numbers, not as text", () => {
    // As text, 9 would be listed before 10, and 990 before 4016.
    expect(
      listed([
        at("2026-10-01", "9", 1),
        at("2026-10-01", "10", 2),
        at("2026-10-01", "990", 3),
        at("2026-10-01", "4016", 4),
      ]),
    ).toEqual(["4016", "990", "10", "9"]);
    expect(compareInvoiceNumbers("10", "9")).toBeGreaterThan(0);
    // Past 2^53 a conversion to a number would round; the digits do not.
    expect(compareInvoiceNumbers("90071992547409930", "90071992547409929")).toBeGreaterThan(0);
  });

  it("[unit] ignores leading zeros, and lets the id separate numbers that are equal", () => {
    expect(compareInvoiceNumbers("007", "7")).toBe(0);
    expect(compareInvoiceNumbers("010", "9")).toBeGreaterThan(0);
    expect(listed([at("2026-10-01", "7", 3), at("2026-10-01", "007", 8)])).toEqual(["007", "7"]);
  });

  it("[unit] compares any other number as text, highest first", () => {
    expect(
      listed([
        at("2026-10-01", "INV-0099", 1),
        at("2026-10-01", "INV-0100", 2),
        at("2026-10-01", "CN-7", 3),
      ]),
    ).toEqual(["INV-0100", "INV-0099", "CN-7"]);
  });

  it("[unit] ranks digits-only numbers ahead of the rest on a day that has both", () => {
    // Pairwise "numbers as numbers, the rest as text" is a cycle: 9 > 1A and
    // 1A > 10 as text, 10 > 9 as numbers. A cursor cannot page a cycle, so the
    // two kinds are ranked apart; this is the only case it decides.
    const day = [at("2026-10-01", "1A", 1), at("2026-10-01", "10", 2), at("2026-10-01", "9", 3)];
    expect(listed(day)).toEqual(["10", "9", "1A"]);
    expect(listed([...day].reverse())).toEqual(["10", "9", "1A"]);
  });

  it("[unit] compares text by code point, the way SQLite compares UTF-8", () => {
    // U+FF21 is a single UTF-16 unit and U+1F600 is two; JavaScript's `<`
    // compares the units and calls the emoji smaller, UTF-8 calls it larger.
    expect("\u{1F600}" < "Ａ").toBe(true);
    expect(compareInvoiceNumbers("\u{1F600}", "Ａ")).toBeGreaterThan(0);
    expect(compareInvoiceNumbers("A", "AB")).toBeLessThan(0);
  });

  it("[unit] is zero only for the same position", () => {
    expect(compareInvoiceListPositions(at("2026-10-01", "1", 5), at("2026-10-01", "1", 5))).toBe(0);
    expect(compareInvoiceListPositions(at("2026-10-01", "1", 5), at("2026-10-01", "1", 4))).toBeLessThan(0);
    expect(compareInvoiceListPositions(at("2026-10-01", "1", 4), at("2026-10-01", "1", 5))).toBeGreaterThan(0);
  });
});
