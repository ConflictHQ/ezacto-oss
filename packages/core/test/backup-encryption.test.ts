import { expect, it } from 'vitest'
import {
  backupBase64,
  backupKeyBytes,
  backupSha256,
  decryptBackupObject,
  encryptBackupObject,
} from '../src/backup-encryption.js'
it('round-trips portable encrypted objects and preserves ciphertext across a checkpoint retry', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32)),
    bytes = new TextEncoder().encode('private payroll and credential material')
  const input = {
    name: 'tables/users.csv',
    bytes,
    sha256: await backupSha256(bytes),
    nonce: crypto.getRandomValues(new Uint8Array(12)),
  }
  expect(backupKeyBytes(backupBase64(key))).toEqual(key)
  const cipher = await encryptBackupObject(input, key)
  expect(await encryptBackupObject(input, key)).toEqual(cipher)
  expect(new TextDecoder().decode(cipher)).not.toContain('private payroll')
  expect(await decryptBackupObject(cipher, key)).toEqual({
    name: input.name,
    bytes,
    sha256: input.sha256,
  })
  await expect(
    encryptBackupObject({ ...input, bytes: new TextEncoder().encode('changed') }, key),
  ).rejects.toThrow('captured checksum')
  const tampered = new Uint8Array(cipher)
  tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1
  await expect(decryptBackupObject(tampered, key)).rejects.toThrow()
  await expect(
    decryptBackupObject(cipher, crypto.getRandomValues(new Uint8Array(32))),
  ).rejects.toThrow('wrong')
  await expect(encryptBackupObject({ ...input, name: '../escape' }, key)).rejects.toThrow(
    'identity',
  )
  expect(() => backupKeyBytes('secret')).toThrow('32-byte')
})
