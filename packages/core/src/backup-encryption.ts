/** Portable authenticated encryption for off-site logical backup objects. */
const magic = new TextEncoder().encode('EZACTO-BACKUP-AES256GCM-V1\n')
const encoder = new TextEncoder()
export const backupBase64 = (bytes: Uint8Array) => {
  let value = ''
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}
export const backupKeyBytes = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value))
    throw new TypeError('Set EZACTO_BACKUP_ENCRYPTION_KEY to a base64url-encoded 32-byte key.')
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  )
  if (bytes.length !== 32 || backupBase64(bytes) !== value)
    throw new TypeError('The backup encryption key must contain exactly 32 bytes.')
  return bytes
}
export const backupSha256 = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
export const backupEncryptionKeyId = async (key: Uint8Array) =>
  (await backupSha256(key)).slice(0, 32)
const validName = (name: string) =>
  name.length <= 512 &&
  /^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/u.test(name) &&
  !name.split('/').some((part) => part === '.' || part === '..' || part === '')
interface Header {
  version: 1
  name: string
  sha256: string
  nonce: string
  key_id: string
}
const aesKey = (key: Uint8Array, usage: 'encrypt' | 'decrypt') => {
  if (key.length !== 32) throw new TypeError('Backup encryption requires a 32-byte key.')
  return crypto.subtle.importKey('raw', new Uint8Array(key).buffer, 'AES-GCM', false, [usage])
}
/** The caller durably freezes nonce and plaintext hash before the first upload. */
export const encryptBackupObject = async (
  input: { name: string; bytes: Uint8Array; sha256: string; nonce: Uint8Array },
  key: Uint8Array,
): Promise<Uint8Array> => {
  if (!validName(input.name) || !/^[0-9a-f]{64}$/u.test(input.sha256) || input.nonce.length !== 12)
    throw new TypeError('Invalid encrypted backup object identity.')
  if ((await backupSha256(input.bytes)) !== input.sha256)
    throw new Error(
      'The backup object changed from its captured checksum; restore the original bundle before resuming.',
    )
  const header: Header = {
    version: 1,
    name: input.name,
    sha256: input.sha256,
    nonce: backupBase64(input.nonce),
    key_id: await backupEncryptionKeyId(key),
  }
  const aad = encoder.encode(JSON.stringify(header))
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(input.nonce).buffer,
        additionalData: aad,
        tagLength: 128,
      },
      await aesKey(key, 'encrypt'),
      new Uint8Array(input.bytes).buffer,
    ),
  )
  const output = new Uint8Array(magic.length + aad.length + 1 + cipher.length)
  output.set(magic)
  output.set(aad, magic.length)
  output[magic.length + aad.length] = 10
  output.set(cipher, magic.length + aad.length + 1)
  return output
}
export const decryptBackupObject = async (bytes: Uint8Array, key: Uint8Array) => {
  if (!magic.every((value, index) => bytes[index] === value))
    throw new Error('Unknown backup encryption format.')
  const end = bytes.indexOf(10, magic.length)
  if (end < magic.length || end > 4096) throw new Error('Invalid backup encryption header.')
  const aad = bytes.slice(magic.length, end)
  const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(aad)) as Header
  if (
    header.version !== 1 ||
    !validName(header.name) ||
    !/^[0-9a-f]{64}$/u.test(header.sha256) ||
    !/^[A-Za-z0-9_-]{16}$/u.test(header.nonce) ||
    header.key_id !== (await backupEncryptionKeyId(key))
  )
    throw new Error('Invalid backup header or wrong backup encryption key.')
  const nonce = Uint8Array.from(atob(header.nonce.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  )
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
      await aesKey(key, 'decrypt'),
      bytes.slice(end + 1),
    ),
  )
  if ((await backupSha256(plaintext)) !== header.sha256)
    throw new Error('The decrypted backup checksum does not match.')
  return { name: header.name, bytes: plaintext, sha256: header.sha256 }
}
