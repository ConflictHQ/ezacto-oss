/** Trusted native session reference, never a cookie/bearer credential or public DTO. */
export interface CsvStagingAuthority {
  userId: number;
  sessionRowId: number;
}
