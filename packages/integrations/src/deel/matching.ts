import type { DeelPerson } from './client.js'

/**
 * Deel matches people by the address their Deel and Wise accounts were opened
 * with, which is not the address Google signs them in with. `user_emails` is
 * gaining an explicit `kind` for exactly this reason, so the match is made
 * against the payroll-kind address by name. Nothing here reads `is_primary`:
 * whichever address is primary can be changed for an unrelated reason, and a
 * payment run must not be what discovers it.
 */
export type EmailKind = 'personal' | 'work' | 'payroll'

export interface DirectoryEmail {
  address: string
  kind: EmailKind
}

export interface DirectoryPerson {
  userId: number
  emails: readonly DirectoryEmail[]
}

export interface ContractMatch {
  userId: number
  payrollEmail: string
  personId: string
  contractId: string
}

export type MatchFailure =
  | 'no_payroll_address'
  | 'ambiguous_payroll_address'
  | 'no_deel_person'
  | 'ambiguous_deel_person'
  | 'no_active_contract'
  | 'ambiguous_active_contract'

export interface UnmatchedDirectoryPerson {
  userId: number
  reason: MatchFailure
}

export interface PayrollContractMatches {
  matches: readonly ContractMatch[]
  unmatched: readonly UnmatchedDirectoryPerson[]
}

/**
 * Deel's own word for a contract that is live and can receive hours. Anything
 * else — completed, cancelled, awaiting signature — is not a place to send
 * time, and treating "the only contract we can see" as active is how hours land
 * on last year's engagement.
 */
export const ACTIVE_DEEL_CONTRACT_STATUS = 'in_progress'

const normalizedAddress = (value: string): string => value.trim().toLowerCase()

export const matchPayrollContracts = (input: {
  people: readonly DirectoryPerson[]
  deelPeople: readonly DeelPerson[]
}): PayrollContractMatches => {
  const byAddress = new Map<string, DeelPerson[]>()
  for (const deelPerson of input.deelPeople) {
    for (const address of deelPerson.emails) {
      const found = byAddress.get(normalizedAddress(address))
      if (found === undefined) byAddress.set(normalizedAddress(address), [deelPerson])
      else found.push(deelPerson)
    }
  }

  const matches: ContractMatch[] = []
  const unmatched: UnmatchedDirectoryPerson[] = []
  for (const person of input.people) {
    const payrollAddresses = person.emails
      .filter((email) => email.kind === 'payroll')
      .map((email) => normalizedAddress(email.address))
    const payrollEmail = payrollAddresses[0]
    if (payrollEmail === undefined) {
      unmatched.push({ userId: person.userId, reason: 'no_payroll_address' })
      continue
    }
    if (new Set(payrollAddresses).size > 1) {
      unmatched.push({ userId: person.userId, reason: 'ambiguous_payroll_address' })
      continue
    }
    const candidates = byAddress.get(payrollEmail) ?? []
    const deelPerson = candidates[0]
    if (deelPerson === undefined) {
      unmatched.push({ userId: person.userId, reason: 'no_deel_person' })
      continue
    }
    if (candidates.length > 1) {
      unmatched.push({ userId: person.userId, reason: 'ambiguous_deel_person' })
      continue
    }
    const active = deelPerson.contracts.filter(
      (contract) => contract.status === ACTIVE_DEEL_CONTRACT_STATUS,
    )
    const contract = active[0]
    if (contract === undefined) {
      unmatched.push({ userId: person.userId, reason: 'no_active_contract' })
      continue
    }
    if (active.length > 1) {
      unmatched.push({ userId: person.userId, reason: 'ambiguous_active_contract' })
      continue
    }
    matches.push({
      userId: person.userId,
      payrollEmail,
      personId: deelPerson.id,
      contractId: contract.id,
    })
  }
  return { matches, unmatched }
}
