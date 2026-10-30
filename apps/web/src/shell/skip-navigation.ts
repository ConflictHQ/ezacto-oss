/** Resolve the destination at activation: every served page shares this shell. */
export const bindSkipNavigation = (shell: HTMLElement): void => {
  shell
    .querySelector<HTMLAnchorElement>('[data-app-skip-link]')
    ?.addEventListener('click', (event) => {
      event.preventDefault()
      if (
        document.documentElement.dataset.authState !== 'authenticated' ||
        shell.closest('[hidden], [inert]') !== null
      )
        return
      const target = [...shell.querySelectorAll<HTMLElement>('main.app-content')].find((main) => {
        const style = getComputedStyle(main)
        return (
          main.closest('[hidden], [inert]') === null &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.visibility !== 'collapse'
        )
      })
      if (target === undefined) return
      target.tabIndex = -1
      target.focus({ preventScroll: true })
      target.scrollIntoView({ behavior: 'auto', block: 'start' })
    })
}
