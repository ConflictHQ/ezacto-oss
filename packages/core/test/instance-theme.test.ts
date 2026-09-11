import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  instancePaletteStylesheet,
  normalizePaletteColor,
  readInstancePalette,
  type InstancePaletteContract,
} from "../src/instance-theme.js";

/**
 * A stand-in for the shell's tokens. Deliberately not the real ones: this
 * module's job is the rule, and pinning it to the shipped palette would turn a
 * retuned brand colour into a failure here.
 */
const contract: InstancePaletteContract = {
  slots: ["ground", "surface", "ink", "muted", "action", "action_fg"],
  base: {
    ground: "#FFFFFF",
    surface: "#F5F6F7",
    ink: "#14161A",
    muted: "#676C74",
    action: "#16794A",
    action_fg: "#FFFFFF",
  },
  requirements: [
    { name: "ink/ground text", foreground: "ink", background: "ground", minimum: 4.5 },
    {
      name: "action/action-fg text",
      foreground: "action",
      background: "action_fg",
      minimum: 4.5,
    },
    { name: "muted/ground text", foreground: "muted", background: "ground", minimum: 4.5 },
  ],
};

const cssVariableFor = (slot: string) => `--ez-${slot.replaceAll("_", "-")}`;

describe("the contrast arithmetic", () => {
  it("[unit] scores the two extremes at the values WCAG fixes them at", () => {
    // These two are defined, not measured: white on black is 21:1 and a colour
    // on itself is 1:1. An arithmetic slip that left the ratio monotonic would
    // still move these.
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 10);
    expect(contrastRatio("#3A7BD5", "#3A7BD5")).toBeCloseTo(1, 10);
  });

  it("[unit] does not care which of the pair is given first", () => {
    expect(contrastRatio("#14161A", "#FFFFFF")).toBeCloseTo(
      contrastRatio("#FFFFFF", "#14161A"),
      10,
    );
  });
});

describe("reading a palette", () => {
  it("[unit] keeps the colours it was given, upper-cased", () => {
    const result = readInstancePalette(
      { ground: "#1d1d1d", surface: "#282828", ink: "#f4f4f4", muted: "#a8a8a8" },
      contract,
    );
    expect(result.errors).toEqual([]);
    expect(result.palette).toEqual({
      ground: "#1D1D1D",
      surface: "#282828",
      ink: "#F4F4F4",
      muted: "#A8A8A8",
    });
  });

  it("[unit] takes a palette that sets nothing", () => {
    // An instance that has cleared every slot is on the built-in theme, which
    // is a state the settings screen can reach and must be able to save.
    expect(readInstancePalette({}, contract)).toEqual({ palette: {}, errors: [] });
  });

  it("[unit] treats an explicit null as clearing that slot, not as a bad colour", () => {
    const result = readInstancePalette({ action: "#0B5E37", surface: null }, contract);
    expect(result.errors).toEqual([]);
    expect(result.palette).toEqual({ action: "#0B5E37" });
  });

  it("[api] names the slot when a colour is not one", () => {
    const result = readInstancePalette({ ground: "cornflower" }, contract);
    expect(result.errors).toEqual([
      {
        field: "palette.ground",
        code: "invalid_color",
        message: "ground must be a six-digit hex colour such as #1D1D1D.",
      },
    ]);
    expect(result.palette).toEqual({});
  });

  it("[api] refuses shorthand rather than deciding what it meant", () => {
    expect(readInstancePalette({ ground: "#abc" }, contract).errors[0]?.code).toBe(
      "invalid_color",
    );
  });

  it("[api] refuses a slot the shell does not declare", () => {
    // Accepting it would store a setting that serves a variable nothing reads,
    // which looks saved and does nothing.
    const result = readInstancePalette({ backdrop: "#1D1D1D" }, contract);
    expect(result.errors).toEqual([
      {
        field: "palette.backdrop",
        code: "unknown_slot",
        message: "backdrop is not a theme slot this instance has.",
      },
    ]);
  });

  it("[api] refuses a palette that is not an object", () => {
    for (const input of ["#1D1D1D", 7, null, ["#1D1D1D"]]) {
      expect(readInstancePalette(input, contract).errors[0]).toEqual({
        field: "palette",
        code: "invalid",
        message: "palette must be an object of slot names to hex colours.",
      });
    }
  });
});

describe("the contrast gate", () => {
  it("[security] refuses a dark ground that leaves the text unreadable", () => {
    // The whole point of the gate. Setting the ground without the ink is the
    // obvious first move on a dark palette, and it is the one that would
    // otherwise leave near-black text on a near-black field -- an instance
    // nobody can sign into to undo it.
    const result = readInstancePalette({ ground: "#1D1D1D" }, contract);
    expect(result.palette).toEqual({});
    const failure = result.errors.find((error) => error.code === "contrast")
    expect(failure?.field).toBe("palette.ground")
    expect(failure?.message).toContain("ink/ground text would be 1.07:1")
    expect(failure?.message).toContain("below the 4.5:1")
  });

  it("[security] takes the same dark ground once the ink comes with it", () => {
    const result = readInstancePalette(
      { ground: "#1D1D1D", surface: "#282828", ink: "#F4F4F4", muted: "#A8A8A8" },
      contract,
    );
    expect(result.errors).toEqual([]);
    expect(result.palette.ground).toBe("#1D1D1D");
  });

  it("[security] holds an accent to the label that is written on it", () => {
    // A brand accent is the value an operator is most likely to paste in, and
    // a light one with white text on it is the most likely way to arrive at a
    // button whose label cannot be read.
    const result = readInstancePalette({ action: "#F1B34A" }, contract);
    expect(result.errors.map((error) => error.field)).toEqual(["palette.action"]);
    expect(result.errors[0]?.code).toBe("contrast");
  });

  it("[api] blames only the slots the operator actually set", () => {
    // `muted/ground` fails here because of the muted value. Naming `ground`
    // alongside it would send someone to a field they did not touch.
    const result = readInstancePalette({ muted: "#D8D8D8" }, contract);
    expect(result.errors.map((error) => error.field)).toEqual(["palette.muted"]);
  });

  it("[api] blames both halves when the operator set both", () => {
    const result = readInstancePalette({ ink: "#777777", ground: "#8A8A8A" }, contract);
    expect(new Set(result.errors.map((error) => error.field))).toEqual(
      new Set(["palette.ink", "palette.ground"]),
    );
  });

  it("[api] reports a malformed colour without also reporting the contrast it broke", () => {
    // The bad value never lands, so every contrast failure it would cause is an
    // artefact. Reporting them reads as five problems when there is one.
    const result = readInstancePalette({ ground: "nope", ink: "#F4F4F4" }, contract);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe("invalid_color");
  });

  it("[unit] ignores a requirement naming a slot the contract has no colour for", () => {
    const sparse: InstancePaletteContract = {
      ...contract,
      requirements: [
        { name: "absent/ground", foreground: "absent", background: "ground", minimum: 4.5 },
      ],
    };
    expect(readInstancePalette({ ground: "#FFFFFF" }, sparse).errors).toEqual([]);
  });
});

describe("normalizing one colour", () => {
  it("[unit] accepts either case and answers in upper", () => {
    expect(normalizePaletteColor("#db394c")).toBe("#DB394C");
    expect(normalizePaletteColor("#DB394C")).toBe("#DB394C");
  });

  it("[unit] answers null for everything that is not a six-digit hex", () => {
    for (const value of ["#abc", "#DB394", "#DB394CC", "db394c", "", 7, null, undefined]) {
      expect(normalizePaletteColor(value)).toBeNull();
    }
  });
});

describe("the served stylesheet", () => {
  it("[unit] writes one custom property per set slot", () => {
    const css = instancePaletteStylesheet(
      { ground: "#1D1D1D", action_fg: "#FFFFFF" },
      cssVariableFor,
    );
    expect(css).toContain("--ez-ground: #1D1D1D;");
    // The underscore in the slot name is a dash in the custom property.
    expect(css).toContain("--ez-action-fg: #FFFFFF;");
    expect(css).toContain(":root {");
  });

  it("[unit] is empty when nothing is set, so the shell can leave the link out", () => {
    expect(instancePaletteStylesheet({}, cssVariableFor)).toBe("");
  });

  it("[unit] orders the declarations so the same palette serves the same bytes", () => {
    // The response is cached by the browser against this content. Two writes of
    // one palette that differ only in key order would look like a change.
    const first = instancePaletteStylesheet(
      { ground: "#1D1D1D", ink: "#F4F4F4" },
      cssVariableFor,
    );
    const second = instancePaletteStylesheet(
      { ink: "#F4F4F4", ground: "#1D1D1D" },
      cssVariableFor,
    );
    expect(first).toBe(second);
  });

  it("[security] drops a stored value that is not a colour instead of serving it", () => {
    // Defence in depth for the one path that puts stored text into a document
    // the browser parses as CSS. A value that closed the declaration and opened
    // a rule of its own would be a stylesheet-injection hole; it cannot reach
    // here through the API, and it is dropped here as well.
    const css = instancePaletteStylesheet(
      { ground: "#1D1D1D", ink: "red; } body { display: none; } :root { --x: a" },
      cssVariableFor,
    );
    expect(css).toContain("--ez-ground: #1D1D1D;");
    expect(css).not.toContain("display: none");
    expect(css).not.toContain("--ez-ink");
  });
});
