import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  getInvariant,
  invariantIds,
  invariantRegistry,
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
      "inv-07",
      "inv-08",
      "inv-09",
      "inv-10",
      "inv-12",
      "inv-13",
    ]);
    for (const definition of invariantRegistry) {
      if (definition.evidence.state === "executable") {
        expect(definition.owner).toMatchObject({
          story: "v0-prove-the-model/schema-core-domain/invariant-suite",
          issue: 87,
        });
        expect(definition.evidence.runtimes).toEqual(["sqlite", "d1"]);
      }
    }

    expect(getInvariant("inv-06")).toMatchObject({
      owner: { story: "v0-5-working-system/invoicing/generation", issue: 50 },
      evidence: { state: "downstream" },
    });
    expect(getInvariant("inv-11")).toMatchObject({
      owner: { story: "v0-5-working-system/invoicing/generation", issue: 50 },
      evidence: { state: "downstream" },
    });
    expect(getInvariant("inv-14")).toMatchObject({
      owner: {
        story: "v0-prove-the-model/load-reconcile/reconcile",
        issue: 77,
      },
      evidence: { state: "downstream" },
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

    for (const definition of invariantRegistry) {
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
    const matches: string[] = [];
    for (const topLevel of ["packages", "entries", "apps"]) {
      for (const path of await walk(join(repositoryRoot, topLevel))) {
        if (!path.endsWith(".ts") || !path.includes(`${join("", "src")}/`))
          continue;
        const source = await readFile(path, "utf8");
        for (const match of source.matchAll(forbidden)) {
          matches.push(`${relative(repositoryRoot, path)}:${match[0]}`);
        }
      }
    }
    expect(matches).toEqual([]);
  });
});
