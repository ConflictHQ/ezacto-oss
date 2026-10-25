/** Private native freshness manifest: normalized-name hashes, IDs and dates, never source labels. */
export interface CsvImportDestinationScope {
  emailHashes: readonly string[];
  clientHashes: readonly string[];
  projectPairs: readonly {
    client: string;
    project: string;
    clientId?: number;
  }[];
  taskHashes: readonly string[];
  personIds?: readonly number[];
  clientIds?: readonly number[];
  projectIds?: readonly number[];
  taskIds?: readonly number[];
  dates: readonly string[];
  includeProjectDefaults: boolean;
}
