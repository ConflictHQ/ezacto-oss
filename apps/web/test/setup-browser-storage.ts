import { Storage } from 'happy-dom'
import { afterAll } from 'vitest'

// Vitest does not replace globals already provided by Node unless they are in
// its explicit DOM key list. Node 25's storage globals consequently shadow
// happy-dom's storage. Use the DOM implementation without touching a disk file.
if (typeof document !== 'undefined') {
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const key of ['localStorage', 'sessionStorage']) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value: new Storage(), writable: true, configurable: true })
  }
  afterAll(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, descriptor)
    }
  })
}
