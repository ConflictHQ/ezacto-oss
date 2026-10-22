import { backupEncryptionKeyId, backupKeyBytes, backupSha256 } from '@ezacto/core'
import { createOffsiteBackupSyncService, type OffsiteBackupSettings } from '@ezacto/db/d1'
import { BackupS3Error, createBackupS3Target } from '@ezacto/integrations/backup-s3'
export interface OffsiteBackupEnvironment {
  EZACTO_BACKUP_S3_BUCKET?: string
  EZACTO_BACKUP_S3_ENDPOINT?: string
  EZACTO_BACKUP_S3_REGION?: string
  EZACTO_BACKUP_S3_PREFIX?: string
  EZACTO_BACKUP_S3_ACCESS_KEY_ID?: string
  EZACTO_BACKUP_S3_SECRET_ACCESS_KEY?: string
  EZACTO_BACKUP_S3_SESSION_TOKEN?: string
  EZACTO_BACKUP_ENCRYPTION_KEY?: string
}
export const createWorkerOffsiteBackups = async (
  database: Parameters<typeof createOffsiteBackupSyncService>[0],
  env: OffsiteBackupEnvironment & {
    APP_BASE_URL?: string
    ATTACHMENTS?: R2Bucket
    ENVIRONMENT?: string
  },
) => {
  let settings: OffsiteBackupSettings = { kind: 'disabled' }
  const configured = Object.entries(env).some(
    ([name, value]) => name.startsWith('EZACTO_BACKUP_') && value !== undefined,
  )
  if (configured) {
    try {
      const {
        EZACTO_BACKUP_S3_BUCKET: bucket,
        EZACTO_BACKUP_S3_ACCESS_KEY_ID: accessKeyId,
        EZACTO_BACKUP_S3_SECRET_ACCESS_KEY: secretAccessKey,
        EZACTO_BACKUP_ENCRYPTION_KEY: encodedKey,
      } = env
      if (!bucket || !accessKeyId || !secretAccessKey || !encodedKey)
        throw new BackupS3Error(
          'Set EZACTO_BACKUP_S3_BUCKET, EZACTO_BACKUP_S3_ACCESS_KEY_ID, EZACTO_BACKUP_S3_SECRET_ACCESS_KEY and EZACTO_BACKUP_ENCRYPTION_KEY together. Credentials belong in Worker secrets.',
        )
      if (!env.ATTACHMENTS || !env.APP_BASE_URL)
        throw new BackupS3Error(
          'Off-site sync requires the ATTACHMENTS source binding and APP_BASE_URL instance identity.',
        )
      const key = backupKeyBytes(encodedKey),
        keyId = await backupEncryptionKeyId(key),
        region = env.EZACTO_BACKUP_S3_REGION ?? 'us-east-1'
      const endpoint = new URL(
        env.EZACTO_BACKUP_S3_ENDPOINT ?? `https://s3.${region}.amazonaws.com`,
      ).toString()
      const prefix = (
        env.EZACTO_BACKUP_S3_PREFIX ?? `${new URL(env.APP_BASE_URL).hostname}/backups`
      ).replace(/\/$/u, '')
      if (
        !prefix ||
        prefix.startsWith('/') ||
        !/^[A-Za-z0-9_./-]+$/u.test(prefix) ||
        prefix.split('/').some((part) => !part || part === '.' || part === '..')
      )
        throw new BackupS3Error(
          'Set EZACTO_BACKUP_S3_PREFIX to a relative instance-specific object prefix without dot segments.',
        )
      const target = createBackupS3Target(
        {
          endpoint,
          region,
          bucket,
          accessKeyId,
          secretAccessKey,
          ...(env.EZACTO_BACKUP_S3_SESSION_TOKEN
            ? { sessionToken: env.EZACTO_BACKUP_S3_SESSION_TOKEN }
            : {}),
        },
        { allowLoopbackHttp: env.ENVIRONMENT === 'test' },
      )
      const objects = env.ATTACHMENTS
      settings = {
        kind: 'ready',
        destinationId: await backupSha256(
          new TextEncoder().encode(JSON.stringify([endpoint, region, bucket, prefix, keyId])),
        ),
        label: `${new URL(endpoint).host}/${bucket}/${prefix}`,
        targetPrefix: prefix + '/runs/',
        keyId,
        key,
        target,
        source: {
          get: async (name) => {
            const object = await objects.get(name)
            if (object === null) return null
            if (object.size > 16 * 1024 * 1024)
              throw new BackupS3Error(
                'An L1 object exceeds the 16 MiB scheduled-sync limit. Use an operator export for larger tables.',
              )
            return new Uint8Array(await object.arrayBuffer())
          },
        },
      }
    } catch (error) {
      settings = {
        kind: 'error',
        message:
          error instanceof BackupS3Error
            ? error.message
            : 'Check the backup S3 endpoint, region, instance URL and base64url-encoded 32-byte encryption key.',
      }
    }
  }
  return createOffsiteBackupSyncService(database, settings, undefined, (error) =>
    console.error('[worker] off-site backup failed', error),
  )
}
