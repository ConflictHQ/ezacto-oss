import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  getInvariant,
  invariantIds,
  invariantRegistry,
  type InvariantDefinition,
} from "../src/invariants.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const walk = async (root: string): Promise<string[]> => {
  const paths: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...(await walk(path)));
    else paths.push(path);
  }
  return paths;
};

const occurrenceCount = (source: string, needle: string): number =>
  source.split(needle).length - 1;

describe("domain invariant registry", () => {
  it("[unit] contains inv-01 through inv-14 exactly once with one owner and fixture contract", () => {
    const expectedIds = Array.from(
      { length: 14 },
      (_, index) => `inv-${String(index + 1).padStart(2, "0")}`,
    );
    expect(invariantIds).toEqual(expectedIds);
    expect(invariantRegistry.map(({ id }) => id)).toEqual(expectedIds);
    expect(new Set(invariantRegistry.map(({ id }) => id))).toHaveLength(14);
    expect(invariantRegistry.map(({ ordinal }) => ordinal)).toEqual(
      Array.from({ length: 14 }, (_, index) => index + 1),
    );
    expect(
      new Set(invariantRegistry.map(({ fixture }) => fixture.id)),
    ).toHaveLength(14);

    for (const definition of invariantRegistry) {
      expect(definition.source).toBe(
        "docs/domain-model.md#8-invariants-the-testable-list",
      );
      expect(definition.owner.story).not.toHaveLength(0);
      expect(definition.owner.issue).toBeGreaterThan(0);
      expect(definition.owner.acceptance).not.toHaveLength(0);
      expect(definition.fixture.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(definition.fixture.given).not.toHaveLength(0);
      expect(definition.fixture.when).not.toHaveLength(0);
      expect(definition.fixture.then).not.toHaveLength(0);
      expect(getInvariant(definition.id)).toBe(definition);
    }
  });

  it("[unit] assigns the exact executable and downstream story owners", () => {
    const executableIds = invariantRegistry
      .filter(({ evidence }) => evidence.state === "executable")
      .map(({ id }) => id);
    expect(executableIds).toEqual([
      "inv-01",
      "inv-02",
      "inv-03",
      "inv-04",
      "inv-05",
      "inv-06",
      "inv-07",
      "inv-08",
      "inv-09",
      "inv-10",
      "inv-11",
      "inv-12",
      "inv-13",
      "inv-14",
    ]);
    for (const definition of invariantRegistry) {
      if (definition.evidence.state === "executable") {
        if (definition.id === "inv-14") {
          expect(definition.owner).toMatchObject({
            story: "v0-prove-the-model/load-reconcile/reconcile",
            issue: 77,
          });
          expect(definition.evidence.runtimes).toEqual(["sqlite"]);
        } else if (definition.id === "inv-06") {
          expect(definition.owner).toMatchObject({
            story: "v0-5-working-system/invoicing/generation",
            issue: 50,
          });
          expect(definition.evidence.runtimes).toEqual(["d1"]);
        } else if (definition.id === "inv-11") {
          expect(definition.owner).toMatchObject({
            story: "v0-5-working-system/invoicing/generation",
            issue: 50,
          });
          expect(definition.evidence.runtimes).toEqual(["sqlite", "d1"]);
        } else {
          expect(definition.owner).toMatchObject({
            story: "v0-prove-the-model/schema-core-domain/invariant-suite",
            issue: 87,
          });
          expect(definition.evidence.runtimes).toEqual(["sqlite", "d1"]);
        }
      }
    }

    expect(getInvariant("inv-06")).toMatchObject({
      owner: { story: "v0-5-working-system/invoicing/generation", issue: 50 },
      evidence: {
        state: "executable",
        testFile: "entries/worker/test/runtime-d1.test.ts",
      },
    });
    expect(getInvariant("inv-11")).toMatchObject({
      owner: { story: "v0-5-working-system/invoicing/generation", issue: 50 },
      evidence: {
        state: "executable",
        testFile: "packages/db/test/invoice-generation.test.ts",
      },
    });
    expect(getInvariant("inv-14")).toMatchObject({
      owner: {
        story: "v0-prove-the-model/load-reconcile/reconcile",
        issue: 77,
      },
      evidence: {
        state: "executable",
        testFile: "packages/migrate/test/reconcile.test.ts",
      },
    });
  });

  it("[unit] resolves every executable owner to one live non-skipped citable test", async () => {
    const testSources = new Map<string, string>();
    for (const topLevel of ["packages", "entries"]) {
      for (const path of await walk(join(repositoryRoot, topLevel))) {
        if (!path.endsWith(".test.ts")) continue;
        testSources.set(
          relative(repositoryRoot, path),
          await readFile(path, "utf8"),
        );
      }
    }

    for (const definition of invariantRegistry as readonly InvariantDefinition[]) {
      const tag = `[${definition.id}]`;
      const occurrences = [...testSources.values()].reduce(
        (total, source) => total + occurrenceCount(source, tag),
        0,
      );
      if (definition.evidence.state === "downstream") {
        expect(
          occurrences,
          `${definition.id} must not have an early placeholder test`,
        ).toBe(0);
        expect(definition.evidence.testContract).not.toHaveLength(0);
        continue;
      }

      expect(
        occurrences,
        `${definition.id} must have one citable executable owner`,
      ).toBe(1);
      const source = testSources.get(definition.evidence.testFile);
      expect(
        source,
        `${definition.evidence.testFile} must exist`,
      ).toBeDefined();
      expect(source).toContain(definition.evidence.testName);
      const namePosition = source!.indexOf(definition.evidence.testName);
      const prefix = source!.slice(
        Math.max(0, namePosition - 80),
        namePosition,
      );
      expect(prefix).not.toMatch(/(?:it|test|describe)\.(?:skip|todo)\s*\(/);
    }
  });

  it("[unit] keeps foreign organization identifiers out of production seams", async () => {
    const forbidden =
      /\b(?:orgId|org_id|organizationId|organization_id|tenantId|tenant_id)\b/g;
    /**
     * Where a vendor's own spelling may appear, because it is their wire format
     * and not one of our seams.
     *
     * The rule exists so an `organizationId` cannot flow through ezacto's types
     * and quietly read as multi-tenancy this product does not have. It said
     * nothing about talking to somebody else's API, and as written it made a
     * vendor whose login field is called `organizationId` impossible to
     * integrate at all -- QuickBooks complies only by the accident of Intuit
     * calling theirs `realmId`.
     *
     * So the exemption is one file per vendor, at the point the request body is
     * built, and it is a list rather than a pattern: every entry is a decision
     * somebody made once, and adding one is visible in review. Our side of that
     * translation is still held to the rule -- BILL's credential carries
     * `companyId` everywhere else in this repository.
     */
    const vendorTransport = [
      join("packages", "integrations", "src", "bill", "session.ts"),
    ];
    const matches: string[] = [];
    for (const topLevel of ["packages", "entries", "apps"]) {
      for (const path of await walk(join(repositoryRoot, topLevel))) {
        if (!path.endsWith(".ts") || !path.includes(`${join("", "src")}/`))
          continue;
        if (vendorTransport.includes(relative(repositoryRoot, path))) continue;
        const source = await readFile(path, "utf8");
        for (const match of source.matchAll(forbidden)) {
          matches.push(`${relative(repositoryRoot, path)}:${match[0]}`);
        }
      }
    }
    expect(matches).toEqual([]);
  });

  it("[unit] writes control characters as escapes, so source stays reviewable", async () => {
    /**
     * Three files carried a raw control character in a string literal rather
     * than its escape: a unit separator delimiting hash inputs in the recurring
     * invoice engine, and a NUL delimiting a composite key in the Deel time
     * sync and guarding input in the Mailgun provider. Every one of them was
     * deliberate and correct, and every one was written as the byte itself.
     *
     * The cost is not to the program, which behaves identically either way. It
     * is that git calls a file binary when a NUL appears in its first 8 KB, so
     * a change to it renders as `Bin 7439 -> 8818 bytes` and cannot be reviewed
     * -- and `grep` skips the file silently, so an audit sweeping the tree for
     * a pattern reports clean on a file it never read. Two of the three were in
     * that state: the outbound mail provider, and a money path.
     *
     * An escape is the same character to the compiler and an ordinary line to
     * everything else.
     */
    const offenders: string[] = [];
    for (const topLevel of ["packages", "entries", "apps", "scripts"]) {
      for (const path of await walk(join(repositoryRoot, topLevel))) {
        if (!/\.(?:ts|tsx|mjs|js|css)$/u.test(path)) continue;
        if (path.includes(`${join("", "node_modules")}/`)) continue;
        if (path.includes(`${join("", "dist")}/`)) continue;
        const source = await readFile(path, "utf8");
        for (const [index, character] of [...source].entries()) {
          const code = character.codePointAt(0)!;
          if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
            offenders.push(
              `${relative(repositoryRoot, path)}:${String(index)}:U+${code
                .toString(16)
                .padStart(4, "0")}`,
            );
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
