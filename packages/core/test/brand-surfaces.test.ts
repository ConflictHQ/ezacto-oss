import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The brand surface audit (#1011), held to the source.
 *
 * `docs/instance-theme.md` lists every surface an instance's colours and marks
 * do or do not reach. This file is the other half: a delivered row must still
 * read the brand source, a gap row must still not (so the row is flipped in
 * the change that closes it), and a page, PDF writer or email builder that has
 * no row fails until it gets one.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

type Status = "delivered" | "gap" | "external" | "none";

interface Surface {
  readonly id: string;
  readonly status: Status;
  /** Repository paths the docs row cites; empty for `none` and `external`. */
  readonly sources: readonly string[];
  /** Limits the checked text to this export, up to the next top-level export. */
  readonly anchor?: string;
  /** A delivered row must match this somewhere in its checked text. */
  readonly reads?: RegExp;
  /** A gap row must not match this anywhere in its checked text. */
  readonly absent?: RegExp;
}

const SHELL = "apps/web/src/shell/render.ts";

const surfaces: readonly Surface[] = [
  { id: "shell-colours", status: "delivered", sources: [SHELL], anchor: "export const renderAppShell", reads: /INSTANCE_THEME_STYLESHEET_PATH/ },
  { id: "shell-marks", status: "delivered", sources: [SHELL], anchor: "export const renderAppShell", reads: /wordmark\(b\.wordmarkDark/ },
  { id: "shell-favicon", status: "delivered", sources: [SHELL], anchor: "export const renderAppShell", reads: /rel="icon"/ },
  { id: "document-shell-marks", status: "delivered", sources: [SHELL], anchor: "export const renderDocumentShell", reads: /wordmarkLight/ },
  { id: "palette-stylesheet", status: "delivered", sources: ["packages/api/src/instance-theme.ts"], reads: /INSTANCE_THEME_STYLESHEET_PATH/ },
  { id: "portal-brand-api", status: "delivered", sources: ["packages/api/src/brand-assets.ts"], reads: /palette/ },
  {
    id: "invoice-pdf-logo",
    status: "delivered",
    sources: ["packages/db/src/money-resources.ts", "entries/worker/src/invoice-documents.ts"],
    reads: /wordmark_light[\s\S]*logoFor|logoFor[\s\S]*wordmark_light/,
  },
  { id: "invoice-pdf-colours", status: "gap", sources: ["packages/core/src/invoice-document.ts"], absent: /palette|instance-theme|InstanceTheme/i },
  {
    id: "report-pdf-name",
    status: "delivered",
    sources: ["packages/db/src/month-end-pack.ts", "packages/core/src/report-document.ts"],
    reads: /resolveReportBrand[\s\S]*input\.brandName|input\.brandName[\s\S]*resolveReportBrand/,
  },
  {
    id: "report-pdf-logo-colours",
    status: "gap",
    sources: ["packages/core/src/report-document.ts"],
    absent: /logo|primaryColor|accentColor|kind: ["']image["']/i,
  },
  {
    id: "email-body",
    status: "gap",
    sources: ["packages/core/src/invoice-email.ts", "packages/core/src/email-templates.ts"],
    absent: /wordmark|palette|brand|instance-theme/i,
  },
  { id: "email-sender", status: "gap", sources: ["packages/mailer/src/index.ts"], absent: /wordmark|palette|emailSenderName|instance-theme/i },
  {
    id: "apple-disconnect",
    status: "gap",
    sources: [SHELL],
    anchor: "export const renderAppleDisconnect",
    absent: /INSTANCE_THEME_STYLESHEET_PATH|wordmark|favicon|instance-theme/i,
  },
  { id: "stripe-checkout", status: "external", sources: [] },
  { id: "native-apps", status: "none", sources: [] },
];

/** The text a row is checked over: the whole file, or one top-level export. */
const regionOf = (path: string, anchor?: string): string => {
  const text = read(path);
  if (anchor === undefined) return text;
  const start = text.indexOf(anchor);
  expect(start, `${path} no longer contains ${anchor}`).toBeGreaterThanOrEqual(0);
  const next = text.indexOf("\nexport ", start + anchor.length);
  return text.slice(start, next === -1 ? undefined : next);
};

const docs = read("docs/instance-theme.md");

const docRows = (): Map<string, { source: string; status: string }> => {
  const section = docs.slice(docs.indexOf("## Brand surface audit"));
  const rows = new Map<string, { source: string; status: string }>();
  for (const line of section.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    const id = /^`([a-z-]+)`$/.exec(cells[1] ?? "")?.[1];
    if (id !== undefined) rows.set(id, { source: cells[3] ?? "", status: cells[4] ?? "" });
  }
  return rows;
};

const sourceFilesUnder = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    if (["node_modules", "dist", "generated", "test"].includes(name)) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFilesUnder(path);
    return /\.(ts|tsx|mjs)$/.test(name) ? [path] : [];
  });

/** Production source of every workspace: `apps/*`, `packages/*`, `entries/*`. */
const allSource = (): string[] =>
  ["apps", "packages", "entries"].flatMap((top) =>
    readdirSync(join(root, top)).flatMap((name) => {
      try {
        return sourceFilesUnder(join(root, top, name, "src"));
      } catch {
        return [];
      }
    }),
  );

describe("brand surface audit (#1011)", () => {
  it("[unit] documents every registered surface with the same status and sources", () => {
    const rows = docRows();
    expect([...rows.keys()].sort()).toEqual(surfaces.map((surface) => surface.id).sort());
    for (const surface of surfaces) {
      const row = rows.get(surface.id)!;
      expect(row.status, `${surface.id} status`).toBe(surface.status);
      if (surface.sources.length === 0) {
        expect(row.source, `${surface.id} source`).toBe("none");
      } else {
        for (const source of surface.sources) {
          expect(row.source, `${surface.id} must cite ${source}`).toContain(`\`${source}\``);
        }
      }
    }
  });

  it("[unit] every cited source file exists", () => {
    for (const surface of surfaces) {
      for (const source of surface.sources) {
        expect(statSync(join(root, source)).isFile(), `${surface.id}: ${source}`).toBe(true);
      }
    }
  });

  it("[unit] a delivered surface still reads the instance brand", () => {
    for (const surface of surfaces.filter((s) => s.status === "delivered")) {
      const text = surface.sources.map((source) => regionOf(source, surface.anchor)).join("\n");
      expect(text, `${surface.id} no longer reads the instance brand`).toMatch(surface.reads!);
    }
  });

  it("[unit] a gap surface does not read the brand yet, so its row is flipped when it does", () => {
    for (const surface of surfaces.filter((s) => s.status === "gap")) {
      for (const source of surface.sources) {
        expect(
          regionOf(source, surface.anchor),
          `${surface.id} now reads the brand in ${source}: mark the row delivered in docs/instance-theme.md and in this test`,
        ).not.toMatch(surface.absent!);
      }
    }
  });

  it("[unit] every HTML page the repository can serve has an audit row", () => {
    const found: Record<string, number> = {};
    for (const file of allSource()) {
      const count = (readFileSync(file, "utf8").match(/<!doctype html/gi) ?? []).length;
      if (count > 0) found[relative(root, file)] = count;
    }
    expect(
      found,
      "an HTML document builder changed: add or update its row in docs/instance-theme.md and surfaces here",
    ).toEqual({ [SHELL]: 2 });
  });

  it("[unit] every PDF writer has an audit row", () => {
    const writers = allSource()
      .filter((file) => file.startsWith(join(root, "packages/core/src")))
      .filter((file) => !file.endsWith("/index.ts"))
      .filter((file) => /from ["']\.\/pdf\.js["']/.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file))
      .sort();
    expect(
      writers,
      "a PDF writer was added or removed: give it a row in docs/instance-theme.md and surfaces here",
    ).toEqual([
      "packages/core/src/invoice-document.ts",
      "packages/core/src/journal-document.ts",
      "packages/core/src/pdf-image.ts",
      "packages/core/src/pdf-text.ts",
      "packages/core/src/report-document.ts",
    ]);
  });

  it("[unit] every email body builder has an audit row", () => {
    const builders = allSource()
      .filter((file) => /escapeEmailHtml/.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file))
      .sort();
    expect(
      builders,
      "an email body builder was added or removed: give it a row in docs/instance-theme.md and surfaces here",
    ).toEqual(["packages/core/src/email-templates.ts", "packages/core/src/invoice-email.ts"]);
  });

  it("[unit] states what is deliberately never branded", () => {
    const section = docs.slice(docs.indexOf("### Deliberately never branded"));
    expect(section).toMatch(/legal and transactional sender/i);
    expect(section).toMatch(/AGPL/);
    expect(section).toMatch(/store listing/i);
  });
});
