import { textWidth, type PdfFont } from "./pdf.js";

/**
 * Setting text for the PDF writer: Harvest's markup, and lines broken by width.
 *
 * Invoice descriptions and notes were written in Harvest, whose invoice form
 * says "Formatting tips: *bold* _italics_", and years of real invoices carry it
 * -- the wire instructions on every CONFLICT invoice end in `*_..._*`. The rules
 * here are the ones Harvest's own PDFs show, read back from the fonts they used
 * rather than assumed:
 *
 * - a span never crosses a line break;
 * - it opens on a `*` or `_` not preceded by a letter, digit or underscore, and
 *   closes on the first matching mark, at least one character later, that is
 *   not followed by one -- so `max_user_instances` and `_stream_readable.js`
 *   stay as typed, and `** note **` is a bold `* note ` and a plain `*`;
 * - spans nest, so `*_x_*` and `_*x*_` are bold italic;
 * - a mark with no partner is printed, never swallowed: `5 * 3` reads `5 * 3`.
 *
 * Whitespace is set the way Harvest's HTML set it: runs of spaces collapse to
 * one and a line loses its leading and trailing spaces. Line breaks are kept
 * exactly, blank lines included.
 */

export interface TextRun {
  readonly text: string;
  readonly font: PdfFont;
}

const isWordCharacter = (character: string | undefined): boolean =>
  character !== undefined && /[\p{L}\p{N}_]/u.test(character);

const styled = (bold: boolean, italic: boolean): PdfFont =>
  bold ? (italic ? "bold_italic" : "bold") : italic ? "italic" : "regular";

const spans = (text: string, bold: boolean, italic: boolean): TextRun[] => {
  const runs: TextRun[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain !== "") runs.push({ text: plain, font: styled(bold, italic) });
    plain = "";
  };
  let index = 0;
  while (index < text.length) {
    const mark = text[index]!;
    if ((mark === "*" || mark === "_") && !isWordCharacter(text[index - 1])) {
      let close = -1;
      for (let candidate = index + 2; candidate < text.length; candidate += 1) {
        if (text[candidate] === mark && !isWordCharacter(text[candidate + 1])) {
          close = candidate;
          break;
        }
      }
      if (close !== -1) {
        flush();
        runs.push(
          ...spans(text.slice(index + 1, close), bold || mark === "*", italic || mark === "_"),
        );
        index = close + 1;
        continue;
      }
    }
    plain += mark;
    index += 1;
  }
  flush();
  return runs;
};

const lines = (text: string): string[] => text.replace(/\r\n?/gu, "\n").split("\n");

/** Leading and trailing spaces off a line of runs, and empty runs out of it. */
const trimmedLine = (runs: readonly TextRun[]): TextRun[] => {
  const kept = runs.map((run) => ({ ...run }));
  while (kept.length > 0 && kept[0]!.text.trimStart() === "") kept.shift();
  if (kept.length > 0) kept[0] = { ...kept[0]!, text: kept[0]!.text.trimStart() };
  while (kept.length > 0 && kept[kept.length - 1]!.text.trimEnd() === "") kept.pop();
  if (kept.length > 0) {
    const last = kept.length - 1;
    kept[last] = { ...kept[last]!, text: kept[last]!.text.trimEnd() };
  }
  return kept;
};

const collapsed = (line: string): string => line.replace(/[ \t\f\v\u00a0]+/gu, " ");

/** Harvest-formatted text as lines of styled runs. `bold` sets the whole of it bold. */
export const markupLines = (text: string, bold = false): readonly (readonly TextRun[])[] =>
  lines(text).map((line) => trimmedLine(spans(collapsed(line), bold, false)));

/** Text with no markup, in one font, as lines -- for a time entry's note. */
export const plainLines = (text: string, font: PdfFont): readonly (readonly TextRun[])[] =>
  lines(text).map((line) => trimmedLine([{ text: collapsed(line), font }]));

type Token =
  | { readonly kind: "space"; readonly font: PdfFont }
  | { readonly kind: "word"; readonly runs: readonly TextRun[] };

const tokens = (line: readonly TextRun[]): Token[] => {
  const out: Token[] = [];
  let word: TextRun[] = [];
  const close = (): void => {
    if (word.length > 0) out.push({ kind: "word", runs: word });
    word = [];
  };
  for (const run of line) {
    for (const character of run.text) {
      if (character === " ") {
        close();
        out.push({ kind: "space", font: run.font });
        continue;
      }
      const last = word[word.length - 1];
      if (last !== undefined && last.font === run.font) word[word.length - 1] = { ...last, text: last.text + character };
      else word.push({ text: character, font: run.font });
    }
  }
  close();
  return out;
};

const widthOf = (runs: readonly TextRun[], size: number): number =>
  runs.reduce((sum, run) => sum + textWidth(run.text, run.font, size), 0);

/** Appends runs to a line, merging a run into the one before it when they share a font. */
const append = (line: TextRun[], runs: readonly TextRun[]): void => {
  for (const run of runs) {
    const last = line[line.length - 1];
    if (last !== undefined && last.font === run.font) line[line.length - 1] = { ...last, text: last.text + run.text };
    else line.push(run);
  }
};

/**
 * A word wider than a whole line -- a URL, a long ticket reference -- cut into
 * pieces that fit. A cut falls after a hyphen or a slash where one lies in the
 * back half of the piece, which is where a reader expects a URL to break; else
 * at the last character that fits. Nothing is dropped.
 */
const pieces = (runs: readonly TextRun[], size: number, measure: number): TextRun[][] => {
  const characters = runs.flatMap((run) => [...run.text].map((text) => ({ text, font: run.font })));
  const out: TextRun[][] = [];
  let start = 0;
  while (start < characters.length) {
    let width = 0;
    let end = start;
    while (end < characters.length) {
      const next = textWidth(characters[end]!.text, characters[end]!.font, size);
      if (end > start && width + next > measure) break;
      width += next;
      end += 1;
    }
    if (end < characters.length) {
      for (let cut = end - 1; cut > start + (end - start) / 2; cut -= 1) {
        if (characters[cut]!.text === "-" || characters[cut]!.text === "/") {
          end = cut + 1;
          break;
        }
      }
    }
    const piece: TextRun[] = [];
    append(piece, characters.slice(start, end));
    out.push(piece);
    start = end;
  }
  return out;
};

/**
 * Breaks one line of runs into lines no wider than `measure` points at `size`,
 * each piece measured in its own font. An empty line stays one empty line.
 */
export const wrapRuns = (
  line: readonly TextRun[],
  size: number,
  measure: number,
): readonly (readonly TextRun[])[] => {
  if (!(measure > 0) || !(size > 0)) throw new RangeError("a wrap needs a positive size and measure");
  const out: TextRun[][] = [];
  let current: TextRun[] = [];
  let width = 0;
  let space: PdfFont | null = null;
  for (const token of tokens(line)) {
    if (token.kind === "space") {
      if (current.length > 0) space = token.font;
      continue;
    }
    const wordWidth = widthOf(token.runs, size);
    const gap = space === null ? 0 : textWidth(" ", space, size);
    if (current.length > 0 && width + gap + wordWidth <= measure) {
      append(current, [{ text: " ", font: space! }, ...token.runs]);
      width += gap + wordWidth;
    } else {
      if (current.length > 0) out.push(current);
      const parts = wordWidth <= measure ? [token.runs.map((run) => ({ ...run }))] : pieces(token.runs, size, measure);
      for (const part of parts.slice(0, -1)) out.push(part);
      current = [...parts[parts.length - 1]!];
      width = widthOf(current, size);
    }
    space = null;
  }
  out.push(current);
  return out;
};

/** Plain text in one font, broken to `measure`, every line break kept. */
export const wrapText = (
  text: string,
  font: PdfFont,
  size: number,
  measure: number,
): readonly string[] =>
  plainLines(text, font).flatMap((line) =>
    wrapRuns(line, size, measure).map((runs) => runs.map((run) => run.text).join("")),
  );

/** Harvest-formatted text broken to `measure`: lines of styled runs. */
export const wrapMarkup = (
  text: string,
  size: number,
  measure: number,
  bold = false,
): readonly (readonly TextRun[])[] =>
  markupLines(text, bold).flatMap((line) => wrapRuns(line, size, measure));

export const runsWidth = (runs: readonly TextRun[], size: number): number => widthOf(runs, size);
