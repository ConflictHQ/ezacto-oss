import type { ProfileNotificationInput, TeamNotificationPreference } from '@conflict-hq/ezacto-client'

/**
 * A person's reminder preferences as a form (issue 935): the daily time
 * reminder, the mail channel, team reminders and the weekly digest.
 *
 * Two screens edit the same row -- whoever administers people, on the Team
 * page, and a person on themselves under Settings -- so the fields are drawn,
 * filled and read in one place. Two copies are how the two come to disagree
 * about what a box means.
 *
 * What cannot be delivered is drawn disabled, with the reason beside it, and is
 * always sent off: the server refuses the rest rather than storing a promise.
 */

const weekdays = [
  ['monday', 'Mon'],
  ['tuesday', 'Tue'],
  ['wednesday', 'Wed'],
  ['thursday', 'Thu'],
  ['friday', 'Fri'],
  ['saturday', 'Sat'],
  ['sunday', 'Sun'],
] as const

type ReminderDay = ProfileNotificationInput['reminder_days'][number]

export const renderNotificationFields = (): string => `
  <label class="team-check"><input name="daily_reminder_enabled" type="checkbox">Daily time reminder</label>
  <label>Reminder time<input name="reminder_time" type="time"></label>
  <fieldset><legend>Reminder days</legend><div class="team-weekdays">${weekdays
    .map(
      ([value, label]) =>
        `<label><input type="checkbox" name="reminder_days" value="${value}">${label}</label>`,
    )
    .join('')}</div></fieldset>
  <p class="hint">A reminder arrives at that time on the person's own clock, and only if they have tracked less than a usual day by then: their weekly capacity over the days chosen. A timer that is running counts.</p>
  <fieldset><legend>Reminder channels</legend>
    <label class="team-check"><input name="channel_email" type="checkbox">Email</label>
    <label class="team-check"><input name="channel_desktop" type="checkbox" disabled>Desktop (not available)</label>
    <label class="team-check"><input name="channel_slack" type="checkbox" disabled>Slack (not available)</label>
    <p class="hint">Reminders are sent by email. Desktop notifications are not delivered, and Slack needs a connector this instance does not have.</p>
  </fieldset>
  <label class="team-check"><input name="include_in_team_reminders" type="checkbox">Remind me to submit my timesheet at the end of the week</label>
  <label class="team-check"><input name="weekly_digest" type="checkbox">Weekly digest of who has not submitted (for people who approve timesheets)</label>
  <p class="hint">The week-end reminder and the digest are sent only when Approval is on and an administrator has set when, under Company settings.</p>
  <label class="team-check"><input name="notify_project_deleted" type="checkbox" disabled>Tell me when a project is deleted (not available)</label>
`

const field = (form: HTMLFormElement, name: string): HTMLInputElement => {
  const control = form.elements.namedItem(name)
  if (!(control instanceof HTMLInputElement)) throw new Error(`missing notification field ${name}`)
  return control
}

/**
 * Fills the form from the stored preferences. Desktop, Slack and the
 * project-deletion notice stay unchecked and disabled whatever was stored: an
 * imported preference nothing honours is not shown as though something did.
 */
export const paintNotificationFields = (
  form: HTMLFormElement,
  preferences: Readonly<TeamNotificationPreference>,
  editable: boolean,
): void => {
  field(form, 'daily_reminder_enabled').checked = preferences.daily_reminder_enabled
  field(form, 'reminder_time').value = preferences.reminder_time ?? ''
  for (const day of form.querySelectorAll<HTMLInputElement>('[name="reminder_days"]')) {
    day.checked = preferences.reminder_days.includes(day.value as ReminderDay)
  }
  field(form, 'channel_email').checked = preferences.channels.email
  field(form, 'include_in_team_reminders').checked = preferences.include_in_team_reminders
  field(form, 'weekly_digest').checked = preferences.weekly_digest
  for (const name of ['channel_desktop', 'channel_slack', 'notify_project_deleted']) {
    const unavailable = field(form, name)
    unavailable.checked = false
    unavailable.disabled = true
  }
  for (const name of [
    'daily_reminder_enabled',
    'reminder_time',
    'channel_email',
    'include_in_team_reminders',
    'weekly_digest',
  ]) {
    field(form, name).disabled = !editable
  }
  for (const day of form.querySelectorAll<HTMLInputElement>('[name="reminder_days"]')) {
    day.disabled = !editable
  }
}

/** The form as the body the server takes. The undeliverable are always off. */
export const readNotificationFields = (form: HTMLFormElement): ProfileNotificationInput => ({
  daily_reminder_enabled: field(form, 'daily_reminder_enabled').checked,
  reminder_time: field(form, 'reminder_time').value === '' ? null : field(form, 'reminder_time').value,
  reminder_days: [...form.querySelectorAll<HTMLInputElement>('[name="reminder_days"]:checked')].map(
    (day) => day.value as ReminderDay,
  ),
  channels: { email: field(form, 'channel_email').checked, desktop: false, slack: false },
  include_in_team_reminders: field(form, 'include_in_team_reminders').checked,
  weekly_digest: field(form, 'weekly_digest').checked,
  notify_project_deleted: false,
})

/**
 * Why the form cannot be saved as it stands, in words, or null. The server says
 * the same thing; saying it first spares a round trip and a vaguer message.
 */
export const notificationFieldsProblem = (input: Readonly<ProfileNotificationInput>): string | null => {
  if (!input.daily_reminder_enabled) return null
  if (input.reminder_time === null) return 'Choose a time for the daily reminder.'
  if (input.reminder_days.length === 0) return 'Choose at least one day for the daily reminder.'
  if (!input.channels.email) return 'The daily reminder is sent by email: tick Email.'
  return null
}
