import type { EzactoClient } from '@conflict-hq/ezacto-client'

export type GithubPublicationUiApi = Pick<EzactoClient, 'getGithubPublications' | 'getGithubReaderStatus' | 'previewGithubPublication' | 'setGithubPublicationPolicy' | 'consentGithubPublication' | 'actGithubPublication'>
