import { escapeEmailHtml } from "./email-templates.js";
import { normalizePaletteColor } from "./instance-theme.js";

/**
 * The instance brand as an HTML email can wear it (#1011): the accent colour of
 * the palette and the light wordmark, nothing else.
 *
 * Both are light-scheme values. An email client ignores `prefers-color-scheme`
 * or inverts the message on its own terms, so the contrast guarantee the shell
 * enforces does not carry over, and the header therefore never relies on the
 * accent for legibility: it is a rule above the message, and any words in the
 * header are the fixed dark ink the line-items table already uses.
 */
export interface EmailBrand {
  /** A `#RRGGBB` accent, the palette's `action` token, or null when not set. */
  readonly accentColor: string | null;
  /**
   * An absolute URL of the light wordmark, content-addressed and public (the
   * `/brand/...` route). Never bytes: an image inlined from user content would
   * ride every message and every queue job.
   */
  readonly logoUrl: string | null;
  /** The organisation name, the logo's alternative text and the text fallback. */
  readonly name: string;
}

/** Marks a message already wearing the header, so a retry does not stack it. */
const marker = 'data-ezacto-brand="header"';

const ink = "#14161A";
const bodyOpen = /<body\b[^>]*>/iu;

const absoluteHttpUrl = (value: string | null): string | null => {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
};

/**
 * The header block, or null when the brand carries nothing to show.
 *
 * The colour is validated again here, though the palette store already holds
 * only validated hex: this string lands in a `style` attribute, and the last
 * writer before the markup is the right place to be sure of it.
 */
export const emailBrandHeader = (brand: EmailBrand | null): string | null => {
  if (brand === null) return null;
  const accent = normalizePaletteColor(brand.accentColor);
  const logo = absoluteHttpUrl(brand.logoUrl);
  const name = brand.name.replace(/\s+/gu, " ").trim();
  if (accent === null && logo === null) return null;
  const rule = accent === null ? "" : `;border-bottom:4px solid ${accent}`;
  const mark =
    logo !== null
      ? `<img src="${escapeEmailHtml(logo)}" alt="${escapeEmailHtml(name)}" ` +
        'style="display:block;border:0;height:auto;max-height:48px;max-width:240px">'
      : name === ""
        ? ""
        : `<div style="font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:700;color:${ink}">${escapeEmailHtml(name)}</div>`;
  return `<div ${marker} style="margin:0 0 16px;padding:0 0 12px${rule}">${mark}</div>`;
};

/**
 * The HTML part of a message with the instance header ahead of its content.
 * A document with a `<body>` gets the header just inside it; a fragment gets it
 * in front. With no brand, or a brand with nothing to show, the input is
 * returned untouched, byte for byte.
 */
export const brandEmailHtml = (html: string, brand: EmailBrand | null): string => {
  if (html.includes(marker)) return html;
  const header = emailBrandHeader(brand);
  if (header === null) return html;
  const body = bodyOpen.exec(html);
  if (body === null) return `${header}${html}`;
  const end = body.index + body[0].length;
  return `${html.slice(0, end)}${header}${html.slice(end)}`;
};
