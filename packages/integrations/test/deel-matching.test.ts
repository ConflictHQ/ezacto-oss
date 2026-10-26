import { describe, expect, it } from 'vitest'
import type { DeelPerson } from '../src/deel/client.js'
import { matchPayrollContracts } from '../src/deel/matching.js'

const deelPeople: readonly DeelPerson[] = [
  {
    id: 'per_ana',
    fullName: 'Ana Vasquez',
    emails: ['ana.personal@example.test'],
    contracts: [{ id: 'con_ana_hourly', status: 'in_progress' }],
  },
  {
    id: 'per_byron',
    fullName: 'Byron Ellis',
    emails: ['byron.personal@example.test'],
    contracts: [
      { id: 'con_byron_old', status: 'completed' },
      { id: 'con_byron_hourly', status: 'in_progress' },
    ],
  },
  {
    id: 'per_cleo',
    fullName: 'Cleo Nakamura',
    emails: ['cleo@example.test'],
    contracts: [
      { id: 'con_cleo_a', status: 'in_progress' },
      { id: 'con_cleo_b', status: 'in_progress' },
    ],
  },
]

describe('matching ezacto people to Deel contracts', () => {
  it('[unit] matches on the payroll address and ignores the work and personal ones', () => {
    const result = matchPayrollContracts({
      people: [
        {
          userId: 7,
          emails: [
            { address: 'ana@halcyon.example', kind: 'work' },
            { address: 'ana.private@example.test', kind: 'personal' },
            { address: 'Ana.Personal@example.test', kind: 'payroll' },
          ],
        },
      ],
      deelPeople,
    })

    expect(result.matches).toEqual([
      {
        userId: 7,
        payrollEmail: 'ana.personal@example.test',
        personId: 'per_ana',
        contractId: 'con_ana_hourly',
      },
    ])
    expect(result.unmatched).toEqual([])
  })

  it('[unit] does not fall back to a work address that Deel happens to know', () => {
    const result = matchPayrollContracts({
      people: [
        {
          userId: 9,
          emails: [{ address: 'byron.personal@example.test', kind: 'work' }],
        },
      ],
      deelPeople,
    })

    expect(result.matches).toEqual([])
    expect(result.unmatched).toEqual([{ userId: 9, reason: 'no_payroll_address' }])
  })

  it('[unit] picks the single in-progress contract and leaves the finished one alone', () => {
    const result = matchPayrollContracts({
      people: [
        { userId: 9, emails: [{ address: 'byron.personal@example.test', kind: 'payroll' }] },
      ],
      deelPeople,
    })

    expect(result.matches).toEqual([
      {
        userId: 9,
        payrollEmail: 'byron.personal@example.test',
        personId: 'per_byron',
        contractId: 'con_byron_hourly',
      },
    ])
  })

  it('[unit] reports the gap instead of guessing when Deel is ambiguous or silent', () => {
    const result = matchPayrollContracts({
      people: [
        { userId: 11, emails: [{ address: 'cleo@example.test', kind: 'payroll' }] },
        { userId: 12, emails: [{ address: 'nobody@example.test', kind: 'payroll' }] },
        {
          userId: 13,
          emails: [
            { address: 'ana.personal@example.test', kind: 'payroll' },
            { address: 'byron.personal@example.test', kind: 'payroll' },
          ],
        },
      ],
      deelPeople,
    })

    expect(result.matches).toEqual([])
    expect(result.unmatched).toEqual([
      { userId: 11, reason: 'ambiguous_active_contract' },
      { userId: 12, reason: 'no_deel_person' },
      { userId: 13, reason: 'ambiguous_payroll_address' },
    ])
  })
})

describe('repeated Deel email addresses', () => {
  const people = [{ userId: 7, emails: [{ address: 'ana.personal@example.test', kind: 'payroll' as const }] }]
  const samePerson: DeelPerson = {
    ...deelPeople[0]!,
    emails: ['ana.personal@example.test', ' ANA.PERSONAL@EXAMPLE.TEST ', 'ana.personal@example.test'],
  }

  it('counts a repeated normalized address once within one person', () => {
    expect(matchPayrollContracts({ people, deelPeople: [samePerson] })).toEqual({
      matches: [{ userId: 7, payrollEmail: 'ana.personal@example.test', personId: 'per_ana', contractId: 'con_ana_hourly' }],
      unmatched: [],
    })
  })

  it.each(['per_other', 'per_ana'])('preserves ambiguity across directory rows even when a second row uses id %s', (id) => {
    const second: DeelPerson = { ...samePerson, id, contracts: [{ id: 'different_contract', status: 'in_progress' }] }
    expect(matchPayrollContracts({ people, deelPeople: [samePerson, second] })).toEqual({
      matches: [],
      unmatched: [{ userId: 7, reason: 'ambiguous_deel_person' }],
    })
  })
})
