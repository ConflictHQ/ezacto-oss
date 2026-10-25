/** Browser-only, read-only inventory. Never collect text, values, URLs or credentials. */
export const collectControlStyles = (
  options: { includeHidden?: boolean; standalone?: boolean } = {},
) => {
  const view = document.defaultView!
  const theme = getComputedStyle(document.documentElement)
  const fonts = ['--ez-font-body', '--ez-font-display', '--ez-font-mono']
    .map((name) => theme.getPropertyValue(name).replaceAll('"', '').trim())
    .filter(Boolean)
  const native = ['checkbox', 'radio', 'range', 'color', 'file', 'hidden']
  return [
    ...document.querySelectorAll<HTMLElement>(
      'a[href],button,input,select,textarea,table,h1,h2,h3,h4',
    ),
  ]
    .filter(
      (node) =>
        !node.matches('input[type=hidden]') &&
        (options.includeHidden ||
          (!node.closest('[hidden],[inert]') &&
            node.getBoundingClientRect().width > 0)),
    )
    .flatMap((node, index) => {
      const style = view.getComputedStyle(node)
      const tag = node.tagName.toLowerCase()
      const reasons: string[] = []
      if (
        !fonts.some((font) =>
          style.fontFamily.replaceAll('"', '').includes(font),
        )
      )
        reasons.push('non-theme-font')
      if (
        tag === 'a' &&
        ['rgb(0, 0, 238)', 'rgb(85, 26, 139)', 'rgb(0, 0, 255)'].includes(
          style.color,
        )
      )
        reasons.push('ua-link-color')
      if (
        (tag === 'button' ||
          (tag === 'input' &&
            ['submit', 'button', 'reset'].includes(
              (node as HTMLInputElement).type,
            ))) &&
        ['outset', 'inset'].includes(style.borderTopStyle)
      )
        reasons.push('ua-button-edge')
      if (
        ['input', 'select', 'textarea'].includes(tag) &&
        !native.includes((node as HTMLInputElement).type) &&
        ['inset', 'outset'].includes(style.borderTopStyle)
      )
        reasons.push('ua-field-edge')
      if (
        tag === 'table' &&
        style.borderCollapse === 'separate' &&
        style.borderSpacing === '2px'
      )
        reasons.push('ua-table-spacing')
      const height = node.getBoundingClientRect().height
      const minimumHeight = parseFloat(style.minHeight) || 0
      const standaloneTarget =
        tag === 'button' ||
        (tag === 'a' && node.matches('.primary-action,.oidc-sign-in')) ||
        (['input', 'select', 'textarea'].includes(tag) &&
          !native.includes((node as HTMLInputElement).type))
      if (
        options.standalone &&
        standaloneTarget &&
        (height || minimumHeight) < 44
      )
        reasons.push('standalone-target-below-44')
      const entry = {
        index,
        tag,
        classes: node.className,
        attributes: node
          .getAttributeNames()
          .filter((name) => name.startsWith('data-')),
        reasons,
        fontFamily: style.fontFamily,
        color: style.color,
        border: style.borderTopStyle,
        targetHeight: Math.round(height),
        minimumHeight,
      }
      if (tag !== 'input' || (node as HTMLInputElement).type !== 'file')
        return [entry]
      const picker = view.getComputedStyle(node, '::file-selector-button')
      const pickerReasons: string[] = []
      if (
        !fonts.some((font) =>
          picker.fontFamily.replaceAll('"', '').includes(font),
        )
      )
        pickerReasons.push('non-theme-font')
      if (['outset', 'inset'].includes(picker.borderTopStyle))
        pickerReasons.push('ua-button-edge')
      return [
        entry,
        {
          ...entry,
          tag: 'input::file-selector-button',
          reasons: pickerReasons,
          fontFamily: picker.fontFamily,
          color: picker.color,
          border: picker.borderTopStyle,
        },
      ]
    })
}
