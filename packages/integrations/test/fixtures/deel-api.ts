/**
 * Response bodies shaped like Deel's `/rest/v2` payloads, trimmed to the fields
 * the adapter reads. They are fixtures on purpose: nothing in this package is
 * allowed to reach the real API from a test.
 */

export const peoplePageOne = {
  data: [
    {
      id: 'per_ana',
      full_name: 'Ana Vasquez',
      emails: [
        { type: 'primary', value: 'Ana.Personal@example.test' },
        { type: 'work', value: 'ana@halcyon.example' },
      ],
      employments: [
        { id: 'con_ana_hourly', contract_status: 'in_progress', type: 'pay_as_you_go' },
      ],
    },
    {
      id: 'per_byron',
      full_name: 'Byron Ellis',
      emails: [{ type: 'primary', value: 'byron.personal@example.test' }],
      employments: [
        { id: 'con_byron_old', contract_status: 'completed', type: 'pay_as_you_go' },
        { id: 'con_byron_hourly', contract_status: 'in_progress', type: 'pay_as_you_go' },
      ],
    },
  ],
  page: { limit: 2, offset: 0, total_rows: 3 },
}

export const peoplePageTwo = {
  data: [
    {
      id: 'per_cleo',
      full_name: 'Cleo Nakamura',
      emails: [{ type: 'primary', value: 'cleo@example.test' }],
      employments: [
        { id: 'con_cleo_a', contract_status: 'in_progress', type: 'pay_as_you_go' },
        { id: 'con_cleo_b', contract_status: 'in_progress', type: 'pay_as_you_go' },
      ],
    },
  ],
  page: { limit: 2, offset: 2, total_rows: 3 },
}

export const timesheetCreated = {
  data: { id: 'tms_0001', contract_id: 'con_ana_hourly', quantity: 7.5 },
}
