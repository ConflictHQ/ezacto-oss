/**
 * The palette an instance sets for itself (#591), and the rule that stops a
 * settable palette from being an unreadable one.
 *
 * WHY THIS IS A RULE AND NOT A FORM. The shell already carries a contrast gate:
 * every colour pair that has to be read -- body text on its ground, a button
 * label on its fill, a status word on its band -- is declared with the ratio it
 * owes, and the built-in theme is held to it. Letting an operator set `ground`
 * to near-black without holding the result to the same bar would ship a
 * settings screen whose obvious use turns the app into black text on a black
 * field, recoverable only by someone with database access. So the palette is
 * validated exactly as the built-in theme is: the override is merged over the
 * base, and the merged palette answers to every requirement. A palette that
 * fails is refused with the slots that failed and the ratio they reached.
 *
 * WHY THE CONTRACT IS INJECTED. This module owns the arithmetic and the rule.
 * It does not own the slot names, the base colours, or which pairs must be
 * legible -- those are the web shell's design tokens, and a copy of them here
 * would be a second source able to drift from the stylesheet the browser
 * actually loads. The caller passes them in.
 */

/**
 * Where the instance palette is served from.
 *
 * Named here rather than in either consumer because the route that serves it
 * and the shell that links it must agree, and they live in packages that do not
 * depend on one another.
 */
export const INSTANCE_THEME_STYLESHEET_PATH = "/assets/instance-theme.css";

export interface PaletteContrastRequirement {
  /** How the pair is named when it fails, e.g. "ink/ground text". */
  name: string;
  foreground: string;
  background: string;
  minimum: number;
}

export interface PaletteFieldError {
  field: string;
  code: string;
  message: string;
}

export interface InstancePaletteContract {
  /** Every slot an instance may set, and the only keys accepted. */
  slots: readonly string[];
  /** The palette an override is merged over -- the built-in theme. */
  base: Readonly<Record<string, string>>;
  requirements: readonly PaletteContrastRequirement[];
}

export interface InstancePaletteResult {
  /** Normalized overrides. Empty when any error was raised. */
  palette: Readonly<Record<string, string>>;
  errors: readonly PaletteFieldError[];
}

const channel = (value: number): number => {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4);
};

const luminance = (color: string): number => {
  if (!/^#[0-9A-Fa-f]{6}$/u.test(color)) {
    throw new Error(`invalid RGB color: ${color}`);
  }
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
};

/**
 * WCAG 2.x relative-luminance contrast, the ratio the gate is stated in.
 *
 * Symmetric by construction: the lighter of the two is always the numerator,
 * so a requirement need not know which of its pair is the darker colour.
 */
export const contrastRatio = (first: string, second: string): number => {
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
};

/**
 * A colour as it is stored, or `null` if it is not one.
 *
 * Six digits and a leading `#`, because that is what the generated stylesheet
 * and the contrast arithmetic both read. Case is normalized rather than
 * refused: an operator pastes `#db394c` out of a brand document, and rejecting
 * that as malformed would be a rule about typing rather than about colour.
 * Shorthand (`#abc`) is refused instead of expanded -- expanding it silently
 * decides that `#abc` meant `#aabbcc`, which is true of CSS but is a guess to
 * make on an operator's behalf about the one value they came here to set.
 */
export const normalizePaletteColor = (value: unknown): string | null =>
  typeof value === "string" && /^#[0-9A-Fa-f]{6}$/u.test(value)
    ? value.toUpperCase()
    : null;

/**
 * Which slots to blame for a failing pair.
 *
 * Only the ones this override actually set: a pair can fail because of a colour
 * the operator chose, and naming the built-in half alongside it sends them
 * looking for a field that is not on the form. When an override sets neither
 * half -- which means the built-in theme itself fails, so a requirement was
 * added without retuning the theme -- the foreground is named, because a
 * message that names nothing cannot be acted on at all.
 */
const blameFor = (
  requirement: PaletteContrastRequirement,
  overridden: ReadonlySet<string>,
): readonly string[] => {
  const touched = [requirement.foreground, requirement.background].filter((slot) =>
    overridden.has(slot),
  );
  return touched.length > 0 ? touched : [requirement.foreground];
};

/**
 * Reads an operator-supplied palette against a contract.
 *
 * Shape is checked before contrast, and a shape failure suppresses the contrast
 * pass entirely: a misspelled slot or a malformed colour would otherwise be
 * reported alongside a list of contrast failures caused by the value that never
 * landed, which reads as five problems when there is one.
 */
export const readInstancePalette = (
  input: unknown,
  contract: Readonly<InstancePaletteContract>,
): InstancePaletteResult => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      palette: {},
      errors: [
        {
          field: "palette",
          code: "invalid",
          message: "palette must be an object of slot names to hex colours.",
        },
      ],
    };
  }

  const known = new Set(contract.slots);
  const palette: Record<string, string> = {};
  const errors: PaletteFieldError[] = [];

  for (const [slot, value] of Object.entries(input)) {
    // A slot the shell does not declare would be written to the database,
    // served in the stylesheet, and style nothing -- a setting that appears to
    // have been accepted and has no effect.
    if (!known.has(slot)) {
      errors.push({
        field: `palette.${slot}`,
        code: "unknown_slot",
        message: `${slot} is not a theme slot this instance has.`,
      });
      continue;
    }
    // Clearing one slot back to the built-in value is how an operator undoes a
    // single choice without retyping the rest of the palette.
    if (value === null) continue;
    const color = normalizePaletteColor(value);
    if (color === null) {
      errors.push({
        field: `palette.${slot}`,
        code: "invalid_color",
        message: `${slot} must be a six-digit hex colour such as #1D1D1D.`,
      });
      continue;
    }
    palette[slot] = color;
  }

  if (errors.length > 0) return { palette: {}, errors };

  const merged = { ...contract.base, ...palette };
  const overridden = new Set(Object.keys(palette));
  for (const requirement of contract.requirements) {
    const foreground = merged[requirement.foreground];
    const background = merged[requirement.background];
    if (foreground === undefined || background === undefined) continue;
    const ratio = contrastRatio(foreground, background);
    if (ratio >= requirement.minimum) continue;
    for (const slot of blameFor(requirement, overridden)) {
      errors.push({
        field: `palette.${slot}`,
        code: "contrast",
        message:
          `${requirement.name} would be ${ratio.toFixed(2)}:1, ` +
          `below the ${requirement.minimum.toFixed(1)}:1 this instance requires ` +
          `to stay readable.`,
      });
    }
  }

  return errors.length > 0 ? { palette: {}, errors } : { palette, errors: [] };
};

/**
 * The stylesheet an instance's palette is served as.
 *
 * A stylesheet and not a `<style>` block: the shell is served under
 * `style-src 'self' https://fonts.googleapis.com`, which admits no inline
 * style, so a `<style>` block would be dropped by the browser and the instance
 * would render the built-in theme with no error anywhere to explain it.
 * Widening the policy to `'unsafe-inline'` for a palette would spend the whole
 * protection the directive exists for.
 *
 * Re-validated on the way out rather than trusted from storage. These values
 * reach a browser inside a stylesheet, so the one thing that must not happen is
 * a stored string closing the declaration and opening a rule of its own. A
 * six-digit hex cannot, and anything that is not one is dropped here rather
 * than served.
 */
export const instancePaletteStylesheet = (
  palette: Readonly<Record<string, string>>,
  cssVariableFor: (slot: string) => string,
): string => {
  const declarations = Object.entries(palette)
    .filter(([, value]) => normalizePaletteColor(value) !== null)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([slot, value]) => `  ${cssVariableFor(slot)}: ${normalizePaletteColor(value)!};`);
  if (declarations.length === 0) return "";
  return [
    "/* Instance palette. Served from the database; not part of the build. */",
    ":root {",
    ...declarations,
    "}",
    "",
  ].join("\n");
};
