/**
 * The filter bar of a report table (issue 930).
 *
 * Labelled controls, the filters that are on listed as chips that each take
 * themselves off, and one Clear filters button. Nothing here narrows rows: a
 * change is handed back and the report reloads through its own API, so the
 * totals and the exports are the server's for the same filters. The values live
 * in the report's address, which is the caller's to write.
 *
 * Every control is a native element, so the keyboard works without help, and
 * every target is at least 44px (see `.filter-bar` in shell.css).
 */

export type FilterValue = string | boolean

interface FilterControlBase {
  /** Stable id; becomes the element id, so a test or a label can find it. */
  readonly id: string
  readonly label: string
}

export interface FilterSelect extends FilterControlBase {
  readonly kind: 'select'
  readonly value: string
  /** The option that means no filter. Its chip is never drawn. */
  readonly neutral: string
  readonly options: readonly (readonly [value: string, label: string])[]
  /** A hook for the report's own attribute, e.g. `data-report-invoice-status`. */
  readonly dataAttribute?: string
}

export interface FilterSearch extends FilterControlBase {
  readonly kind: 'search'
  readonly value: string
}

export interface FilterToggle extends FilterControlBase {
  readonly kind: 'toggle'
  readonly checked: boolean
}

export type FilterControl = FilterSelect | FilterSearch | FilterToggle

export interface FilterBarSpec {
  /** Names the group for assistive technology, e.g. "Detailed time filters". */
  readonly label: string
  readonly controls: readonly FilterControl[]
  readonly onChange: (id: string, value: FilterValue) => void
  readonly onClear: () => void
}

interface Chip {
  readonly id: string
  readonly text: string
  readonly cleared: FilterValue
}

const chipsOf = (controls: readonly FilterControl[]): Chip[] => {
  const chips: Chip[] = []
  for (const control of controls) {
    if (control.kind === 'select') {
      if (control.value === control.neutral) continue
      const option = control.options.find(([value]) => value === control.value)
      chips.push({
        id: control.id,
        text: `${control.label}: ${option?.[1] ?? control.value}`,
        cleared: control.neutral,
      })
    } else if (control.kind === 'search') {
      if (control.value.trim() === '') continue
      chips.push({ id: control.id, text: `${control.label}: ${control.value}`, cleared: '' })
    } else if (control.checked) {
      chips.push({ id: control.id, text: control.label, cleared: false })
    }
  }
  return chips
}

/**
 * The control that last changed, by id. The report redraws itself from the
 * server's answer, which replaces the bar; focus goes back to the same control
 * so a keyboard user keeps their place.
 */
let focusAfterRedraw: string | null = null

const keepFocus = (id: string): void => {
  focusAfterRedraw = id
}

export const renderFilterBar = (spec: Readonly<FilterBarSpec>): HTMLElement => {
  const root = document.createElement('div')
  root.className = 'filter-bar'
  root.setAttribute('role', 'group')
  root.setAttribute('aria-label', spec.label)

  const fields = document.createElement('div')
  fields.className = 'filter-bar-fields'
  for (const control of spec.controls) {
    const field = document.createElement('div')
    field.className = control.kind === 'toggle' ? 'filter-bar-field filter-bar-toggle' : 'filter-bar-field'
    const label = document.createElement('label')
    label.htmlFor = control.id
    label.textContent = control.label
    if (control.kind === 'select') {
      const select = document.createElement('select')
      select.id = control.id
      if (control.dataAttribute !== undefined) select.setAttribute(control.dataAttribute, '')
      for (const [value, text] of control.options) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = text
        select.append(option)
      }
      select.value = control.value
      select.addEventListener('change', () => {
        keepFocus(control.id)
        spec.onChange(control.id, select.value)
      })
      field.append(label, select)
    } else if (control.kind === 'search') {
      const input = document.createElement('input')
      input.id = control.id
      input.type = 'search'
      input.value = control.value
      input.autocomplete = 'off'
      // `change` fires on Enter and on leaving the field, which is when a
      // search should go to the server: not once per keystroke.
      input.addEventListener('change', () => {
        keepFocus(control.id)
        spec.onChange(control.id, input.value.trim())
      })
      field.append(label, input)
    } else {
      const input = document.createElement('input')
      input.id = control.id
      input.type = 'checkbox'
      input.checked = control.checked
      input.addEventListener('change', () => {
        keepFocus(control.id)
        spec.onChange(control.id, input.checked)
      })
      field.append(input, label)
    }
    fields.append(field)
  }
  root.append(fields)

  const chips = chipsOf(spec.controls)
  if (chips.length > 0) {
    const list = document.createElement('ul')
    list.className = 'filter-bar-chips'
    list.setAttribute('aria-label', 'Active filters')
    for (const chip of chips) {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'filter-bar-chip'
      button.dataset['filterChip'] = chip.id
      button.setAttribute('aria-label', `Remove filter ${chip.text}`)
      const text = document.createElement('span')
      text.textContent = chip.text
      const mark = document.createElement('span')
      mark.setAttribute('aria-hidden', 'true')
      mark.textContent = '×'
      button.append(text, mark)
      button.addEventListener('click', () => {
        keepFocus(chip.id)
        spec.onChange(chip.id, chip.cleared)
      })
      item.append(button)
      list.append(item)
    }
    const clear = document.createElement('button')
    clear.type = 'button'
    clear.className = 'filter-bar-clear'
    clear.textContent = 'Clear filters'
    clear.addEventListener('click', () => {
      focusAfterRedraw = null
      spec.onClear()
    })
    root.append(list, clear)
  }

  const wanted = focusAfterRedraw
  if (wanted !== null) {
    queueMicrotask(() => {
      const target = root.querySelector<HTMLElement>(`[id="${wanted}"]`) ??
        root.querySelector<HTMLElement>('.filter-bar-clear')
      if (target?.isConnected) {
        target.focus()
        focusAfterRedraw = null
      }
    })
  }
  return root
}
