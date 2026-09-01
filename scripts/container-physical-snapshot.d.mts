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
