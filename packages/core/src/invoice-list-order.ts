/**
 * The order the invoice list is read in: newest first.
 *
 * The list paged by id, ascending, and ids say nothing about age here. The
 * Harvest import numbered its invoices newest first, so id 1 is the most
 * recent import, and an invoice raised here takes either the next id or a
 * large one derived from a hash. Either way a new invoice sat behind every
 * page of the book, and an operator who could not find a paid invoice took it
 * to have disappeared.
 *
 * So the list is ordered by what a person means by newest:
 *
 * 1. the issue date, latest first;
 * 2. then the number, highest first -- as a number where it is made of digits
 *    alone, as text otherwise, and on a day that has both kinds the numeric
 *    ones first;
 * 3. then the id, highest first, so no two rows ever tie and a cursor always
 *    names one place in the list.
 *
 * "Numerically when both are digits, as text otherwise" is not an order on its
 * own: 9 > 1A as text, 1A > 10 as text, and 10 > 9 as numbers is a cycle, and
 * a cursor cannot page through a cycle. Ranking the all-digit numbers apart
 * from the rest is the smallest change that makes it one; it only decides
 * anything on a day that mixes the two, which a book rarely does.
 *
 * The database sorts by the same rule (`invoiceNumberOrderKey` in
 * `packages/db/src/money-resources.ts`), and the list endpoint checks every
 * page it is handed against this comparison, so the two have to agree
 * exactly. Text is compared by code point rather than with JavaScript's `<`,
 * because SQLite compares UTF-8 bytes and that is code-point order; `<`
 * compares UTF-16 units, which disagree for characters beyond U+FFFF.
 */

/** Where an invoice sits in the list. A page resumes strictly after one. */
export interface InvoiceListPosition {
  readonly issueDate: string;
  readonly number: string;
  readonly id: number;
}

const digitsOnly = /^[0-9]+$/u;

/** Negative, zero or positive as `left` sorts below, level with or above `right`. */
const compareCodePoints = (left: string, right: string): number => {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
};

/**
 * Negative when `left` is the lower invoice number, positive when it is the
 * higher, zero when they rank level (`007` and `7`, which the id then
 * separates).
 */
export const compareInvoiceNumbers = (left: string, right: string): number => {
  const leftNumeric = digitsOnly.test(left);
  const rightNumeric = digitsOnly.test(right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? 1 : -1;
  if (!leftNumeric) return compareCodePoints(left, right);
  // Leading zeros carry no value, and without them the longer run of digits
  // is the larger number -- which holds at any length, where converting to a
  // number would stop being exact past 2^53.
  const leftDigits = left.replace(/^0+/u, "");
  const rightDigits = right.replace(/^0+/u, "");
  if (leftDigits.length !== rightDigits.length) {
    return leftDigits.length - rightDigits.length;
  }
  return compareCodePoints(leftDigits, rightDigits);
};

/**
 * Negative when `left` is listed before `right`. Zero only for the same
 * position, because the id breaks every other tie.
 */
export const compareInvoiceListPositions = (
  left: InvoiceListPosition,
  right: InvoiceListPosition,
): number =>
  compareCodePoints(right.issueDate, left.issueDate) ||
  compareInvoiceNumbers(right.number, left.number) ||
  right.id - left.id;
