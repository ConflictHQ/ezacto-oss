import type {
  CsvImportCapabilities,
  CsvImportRun,
  CsvImportPreview,
  CsvImportMapping,
  CsvImportMappingState,
  CsvImportSourceEntity,
  CsvImportCandidate,
  CsvImportLineError,
  CsvImportApplyCommand,
  CsvImportApplyRun,
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
export type ApplyCommand = CsvImportApplyCommand
export type ApplyStatus = CsvImportApplyRun

export type ImportStagingApi = Pick<EzactoClient,
  'getCsvImportCapabilities' | 'uploadCsvImport' | 'getCsvImportMapping' |
  'mapCsvImport' | 'previewCsvImport' | 'getCsvImport' | 'listCsvImportErrors' |
  'listCsvImportCatalog' | 'downloadCsvImportDiagnostics' | 'purgeCsvImportInput'>
export type ImportApi = ImportStagingApi & Pick<EzactoClient,
  'applyCsvImport' | 'resumeCsvImport' | 'cancelCsvImport' | 'getCsvImportApply'>

/** A stop is never a rollback, even when valid setup remains without time. */
export const cancelNotice = (committed: number, createdSetup: number): string =>
  `Import stopped. ${committed} committed time rows and ${createdSetup} created setup records remain. Nothing was rolled back.`
