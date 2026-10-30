# Hosted example projects

Hosted provisioning may insert one clearly named example client and project, with
an assigned General task and the owner on the project team, inside the same
transaction that first creates the organization. The project is non-billable;
its task assignment is non-billable. This makes a first time entry possible
without setup. A neutral General default task remains useful on future projects.
Self-hosted bootstrap does not seed example data.

The trusted provisioner marks only this practice project with
`projects.is_example = 1`. Ordinary creation uses the default `0`; the public
project mutation API does not let a caller mark ordinary work as an example.
The name and notes must explain that it is practice data and that Archive removes
its practice time from reports. Owners should create a separate project for real
work rather than repurpose the example.

The existing project Archive action sets `is_active = 0`. The report projections
`report_projects`, `report_time_entries`, and `report_expenses` omit archived
examples only. Built-in and saved reports read those projections; restoring an
example makes its practice records visible again. Ordinary archived projects keep
their historical reporting behavior. Invoice candidates already require an active
project; non-billable example time is not eligible for an invoice.

Archiving never deletes or rewrites time, expenses, or financial records. The
example records remain in the regular tenant tables and follow the ordinary
export, retention, and tenant erasure paths. There is no additional store to erase.
The marker migration does not create examples in existing databases.
