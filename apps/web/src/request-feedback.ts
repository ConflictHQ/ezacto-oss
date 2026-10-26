/** Presentation only: the owning controller keeps its request, retry and session rules. */
export const setRequestBusy = (region: HTMLElement, busy: boolean): void => {
  region.setAttribute('aria-busy', String(busy))
  region.toggleAttribute('data-request-busy', busy)
  // Keep the caller's semantics: buttons stay buttons, and only existing
  // status regions announce text. Whole forms must not become live regions.
}
