import { canManageCommercialTerms } from '@ezacto/core'
import type { Whoami } from '@conflict-hq/ezacto-client'

export const canManageClientTerms = (identity: Pick<Whoami, 'profile' | 'manager_grants'>): boolean =>
  canManageCommercialTerms({ profile: identity.profile, managerGrants: identity.manager_grants })
