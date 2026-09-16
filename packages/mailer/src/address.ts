/**
 * Composing an RFC 5322 address from a display name and a mailbox.
 *
 * #738. Both providers built `${name} <${email}>` from a name the sender never
 * controls: a client contact's name, a user's own name, whatever the
 * organization typed. A name holding a comma splits one recipient into two, and
 * one holding `<` or `>` can move the mailbox itself, so a display name was
 * enough to redirect or widen delivery. The email is already validated against
 * a pattern; the name was not treated as data at all.
 *
 * RFC 5322 has one answer: a display name containing anything outside `atext`
 * is a quoted-string, with backslash and quote escaped inside it.
 */

/**
 * Characters that force the display name into a quoted-string.
 *
 * Not whitespace: a display-name is a phrase, and a phrase is atoms separated
 * by spaces, so "Ada Lovelace" is legal bare. Quoting every name would also be
 * valid but would rewrite the From and To of every message we send, to fix
 * nothing. Control characters are stripped before this is consulted.
 */
const specials = /[()<>[\]:;@\\,."]/

/** Control characters have no representation in a header, so they are dropped. */
// eslint-disable-next-line no-control-regex
const controls = /[\x00-\x1F\x7F]/gu

export const formatAddress = (email: string, name?: string): string => {
  if (name === undefined) return email
  const cleaned = name.replace(controls, '').trim()
  if (cleaned === '') return email
  if (!specials.test(cleaned)) return `${cleaned} <${email}>`
  return `"${cleaned.replace(/([\\"])/g, '\\$1')}" <${email}>`
}
