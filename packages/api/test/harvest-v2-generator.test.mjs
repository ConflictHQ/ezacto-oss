import { describe, expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  rm,
  mkdir,
  writeFile,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  assertSynthetic,
  createCorpus,
  generate,
  syntheticNumber,
} from "../../../scripts/harvest-shim-corpus.mjs";

const sourceClient = () => ({
  id: 987654321,
  name: "Private Customer Incorporated",
  address: "77 Secret Avenue",
  currency: "USD",
  is_active: true,
  created_at: "2026-09-02T05:07:41Z",
  updated_at: "2026-10-01T03:08:42Z",
  statement_key: "DO-NOT-EXPORT-THIS-SECRET",
});

describe("recorded Harvest corpus generator", () => {
  it("replaces identifiers, contacts, dates and text without rendering the golden through the shim", () => {
    const [pair] = createCorpus({ clients: [sourceClient()] });
    expect(pair.golden).toEqual({
      id: 1001,
      name: "Sample clients name 1001",
      is_active: true,
      address: "Sample clients address 1001",
      currency: "USD",
      created_at: "2024-02-03T10:20:30Z",
      updated_at: "2024-02-03T10:20:30Z",
    });
    expect(pair.input).toEqual({
      id: 1001,
      createdAt: "2024-02-03T10:20:30Z",
      updatedAt: "2024-02-03T10:20:30Z",
      name: "Sample clients name 1001",
      isActive: true,
      address: "Sample clients address 1001",
      currency: "USD",
    });
    expect(JSON.stringify(pair)).not.toMatch(/Private|Secret|987654321|2026-/);
    assertSynthetic(pair.input);
    assertSynthetic(pair.golden);
  });

  it("preserves numeric representation classes without retaining magnitudes", () => {
    expect(syntheticNumber("147.300")).toBe("2.222");
    expect(syntheticNumber(-987.61)).toBe(-2.22);
    expect(syntheticNumber(0)).toBe(0);
    expect(syntheticNumber(null)).toBeNull();
    expect(syntheticNumber(0.12, true)).toBe(0.22);
    expect(syntheticNumber(7.12, true)).toBe(2.22);
    expect(syntheticNumber(117.12, true)).toBe(26.22);
  });

  it("rejects unapproved strings instead of copying them or weakening the allowlist", () => {
    expect(() =>
      assertSynthetic({ nested: ["person@private.example"] }),
    ).toThrow("unsupported string");
    expect(() =>
      createCorpus({
        clients: [{ ...sourceClient(), currency: "Private currency label" }],
      }),
    ).toThrow("Unsupported enum currency");
  });

  it("rejects synthetic secret sentinels in every copied enum and nested currency", () => {
    const fixture = (resource, name) =>
      JSON.parse(
        readFileSync(
          new URL(
            `./fixtures/harvest-v2/${resource}/${name}.golden.json`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
    const sentinel = "Sample SYNTHETIC_SENTINEL";
    for (const field of ["bill_by", "budget_by"]) {
      const project = fixture("projects", "snapshot-001");
      project[field] = sentinel;
      expect(() => createCorpus({ projects: [project] })).toThrow(
        `Unsupported enum ${field}`,
      );
    }
    const user = fixture("users", "snapshot-001");
    user.access_roles = [sentinel];
    expect(() => createCorpus({ users: [user] })).toThrow(
      "Unsupported enum access_roles",
    );
    const entry = fixture("time_entries", "snapshot-001");
    entry.approval_status = sentinel;
    expect(() => createCorpus({ time_entries: [entry] })).toThrow(
      "Unsupported enum approval_status",
    );
    const project = fixture("projects", "snapshot-001");
    project.client.currency = sentinel;
    expect(() => createCorpus({ projects: [project] })).toThrow(
      "Unsupported enum currency",
    );
    expect(() =>
      createCorpus({ clients: [{ ...sourceClient(), is_active: sentinel }] }),
    ).toThrow("Unsupported boolean");
  });

  it("rejects invoice enum sentinels and replaces free-form line labels", () => {
    const invoice = JSON.parse(
      readFileSync(
        new URL(
          "./fixtures/harvest-v2/invoices/snapshot-001.golden.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    invoice.creator = null;
    for (const field of ["state", "payment_term"]) {
      expect(() =>
        createCorpus({
          invoices: [{ ...invoice, [field]: "Sample SYNTHETIC_SENTINEL" }],
        }),
      ).toThrow(`Unsupported enum ${field}`);
    }
    expect(() =>
      createCorpus({
        invoices: [
          { ...invoice, payment_options: ["Sample SYNTHETIC_SENTINEL"] },
        ],
      }),
    ).toThrow("Unsupported enum payment_options");
    invoice.line_items[0].kind = "Sample PRIVATE_LINE_LABEL";
    const [pair] = createCorpus({ invoices: [invoice] });
    expect(JSON.stringify(pair)).not.toContain("PRIVATE_LINE_LABEL");
    assertSynthetic(pair.input);
    assertSynthetic(pair.golden);
  });

  it("never overwrites a directory or writes raw data into provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvest-corpus-generator-"));
    try {
      const source = join(root, "source"),
        out = join(root, "out");
      await mkdir(join(source, "raw"), { recursive: true });
      await writeFile(
        join(source, "raw", "clients.jsonl"),
        JSON.stringify({
          ...sourceClient(),
          ["Sample SYNTHETIC_SECRET_KEY"]: "private",
        }) + "\n",
      );
      await writeFile(
        join(source, "manifest.json"),
        JSON.stringify({ private_name: "Do not expose" }),
      );
      const result = await generate(source, out);
      expect(result.counts.clients).toBe(1);
      expect(result.unsupported_field_counts.clients).toBe(2);
      expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET_KEY");
      expect(JSON.stringify(result)).not.toMatch(
        /Do not expose|Private Customer|statement_key.*DO-NOT/,
      );
      await expect(generate(source, out)).rejects.toThrow();
      await expect(generate(source, join(source, "output"))).rejects.toThrow(
        "separate",
      );
      const alias = join(root, "alias-to-private-source");
      await symlink(source, alias, "dir");
      await expect(generate(source, join(alias, "output"))).rejects.toThrow(
        "separate",
      );
      const saved = await readFile(
        join(out, "clients", "snapshot-001.golden.json"),
        "utf8",
      );
      expect(saved).not.toMatch(/Private|Secret|987654321/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
