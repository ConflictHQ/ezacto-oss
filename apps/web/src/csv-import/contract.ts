import type {
  CsvImportCapabilities,
  CsvImportRun,
  CsvImportPreview,
  CsvImportMapping,
  CsvImportMappingState,
  CsvImportSourceEntity,
  CsvImportCandidate,
  CsvImportLineError,
  EzactoClient,
} from '@conflict-hq/ezacto-client'

/** The actual generated staging contract is the only wire DTO source. */
export type ImportCapability = CsvImportCapabilities
export type ImportRun = CsvImportRun
export type ImportPreview = CsvImportPreview
export type ImportMapping = CsvImportMapping
export type ImportMappingState = CsvImportMappingState
export type SourceEntity = CsvImportSourceEntity
export type DestinationCandidate = CsvImportCandidate
export type ImportDiagnostic = CsvImportLineError
export type EntityKind = SourceEntity['kind']

export type ImportStagingApi = Pick<EzactoClient,
  'getCsvImportCapabilities' | 'uploadCsvImport' | 'getCsvImportMapping' |
  'mapCsvImport' | 'previewCsvImport' | 'getCsvImport' | 'listCsvImportErrors' |
  'listCsvImportCatalog' | 'downloadCsvImportDiagnostics' | 'purgeCsvImportInput'>
export type ImportApi = ImportStagingApi
