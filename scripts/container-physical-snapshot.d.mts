export interface PhysicalSnapshotSource {
  container: string;
  volume: string;
  image: string;
  image_id: string;
}

export interface PhysicalSnapshotFile {
  path: string;
  byte_size: number;
  sha256: string;
}

export interface PhysicalSnapshotMetadata {
  schema_version: 1;
  kind: "ezacto-container-physical-snapshot";
  created_at: string;
  source: PhysicalSnapshotSource;
  files: PhysicalSnapshotFile[];
}

export function createPhysicalSnapshotMetadata(
  root: string,
  source: PhysicalSnapshotSource,
  createdAt?: string,
): Promise<PhysicalSnapshotMetadata>;

export function verifyPhysicalSnapshot(
  root: string,
): Promise<PhysicalSnapshotMetadata>;

export function createCanonicalTemporaryDirectory(
  prefix: string,
  parent?: string,
): Promise<string>;

export function restorePhysicalSnapshot(
  options: { bundle: string; volume: string; image: string },
  execute?: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
): Promise<void>;

/** Read-only stopped-volume inventory; private staging is never copied. */
export const physicalSnapshotSourceEntriesHelper: string;
