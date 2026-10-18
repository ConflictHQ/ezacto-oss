import { describe, expect, it } from "vitest";
import {
  composeDailyTimeReminder,
  composeSubmissionDigest,
  composeSubmissionReminder,
  effectiveTimeZone,
  localMoment,
  reminderTiming,
  submissionReminderWeek,
  trackedLessThanUsual,
  usableTimeZone,
  usualDaySeconds,
} from "../src/time-reminder.js";

describe("whose clock a reminder is read on (issue 935)", () => {
  it("[unit] prefers a person's own zone, then the organization's, then UTC", () => {
    expect(effectiveTimeZone("Europe/Warsaw", "America/Costa_Rica")).toBe("Europe/Warsaw");
    // Never set: the column default.
    expect(effectiveTimeZone("UTC", "America/Costa_Rica")).toBe("America/Costa_Rica");
    expect(effectiveTimeZone(null, "America/Costa_Rica")).toBe("America/Costa_Rica");
    // Imported display names the calendar refuses fall to the organization, not to UTC.
    expect(effectiveTimeZone("Central America", "America/Costa_Rica")).toBe("America/Costa_Rica");
    expect(effectiveTimeZone("Warsaw", "Not/AZone")).toBe("UTC");
    expect(usableTimeZone("Europe/Warsaw")).toBe(true);
    expect(usableTimeZone("Warsaw")).toBe(false);
  });

  it("[unit] reads an instant as the date, time and weekday on a wall", () => {
    // 22:30 on a Tuesday in UTC is already Wednesday morning in Warsaw and still Tuesday in Costa Rica.
    const instant = "2026-10-13T22:30:00.000Z";
    expect(localMoment(instant, "UTC")).toEqual({ date: "2026-10-13", time: "22:30", weekday: "tuesday" });
    expect(localMoment(instant, "Europe/Warsaw")).toEqual({
      date: "2026-10-14",
      time: "00:30",
      weekday: "wednesday",
    });
    expect(localMoment(instant, "America/Costa_Rica")).toEqual({
      date: "2026-10-13",
      time: "16:30",
      weekday: "tuesday",
    });
    // Midnight reads 00:00, never 24:00.
    expect(localMoment("2026-10-13T22:00:00.000Z", "Europe/Warsaw").time).toBe("00:00");
  });
});

describe("when a reminder is due (issue 935)", () => {
  it("[unit] is not due before its time, due for two hours after, and late beyond that", () => {
    expect(reminderTiming({ time: "16:59" }, "17:00")).toBe("not_yet");
    expect(reminderTiming({ time: "17:00" }, "17:00")).toBe("due");
    expect(reminderTiming({ time: "19:00" }, "17:00")).toBe("due");
    expect(reminderTiming({ time: "19:01" }, "17:00")).toBe("late");
  });

  it("[unit] expects a usual day of capacity over the chosen days, and anything at all of zero capacity", () => {
    expect(usualDaySeconds(126_000, 5)).toBe(25_200);
    expect(usualDaySeconds(0, 5)).toBe(0);
    expect(usualDaySeconds(126_000, 0)).toBe(0);
    expect(trackedLessThanUsual(25_199, 25_200)).toBe(true);
    expect(trackedLessThanUsual(25_200, 25_200)).toBe(false);
    expect(trackedLessThanUsual(0, 0)).toBe(true);
    expect(trackedLessThanUsual(60, 0)).toBe(false);
  });
});

describe("which week a submission reminder is about (issue 935)", () => {
  const on = (date: string, weekday: Parameters<typeof submissionReminderWeek>[0]["weekday"]) => ({ date, weekday });

  it("[unit] is last week on the first four days of a week, and this week after", () => {
    // Weeks start Monday.
    expect(submissionReminderWeek(on("2026-10-19", "monday"), "monday")).toEqual({
      start: "2026-10-12",
      end: "2026-10-18",
    });
    expect(submissionReminderWeek(on("2026-10-22", "thursday"), "monday")).toEqual({
      start: "2026-10-12",
      end: "2026-10-18",
    });
    expect(submissionReminderWeek(on("2026-10-23", "friday"), "monday")).toEqual({
      start: "2026-10-19",
      end: "2026-10-25",
    });
    expect(submissionReminderWeek(on("2026-10-25", "sunday"), "monday")).toEqual({
      start: "2026-10-19",
      end: "2026-10-25",
    });
  });

  it("[unit] follows the organization's first day of the week", () => {
    // Sunday-start weeks: Sunday 18 October opens 18-24, so it reminds about 11-17.
    expect(submissionReminderWeek(on("2026-10-18", "sunday"), "sunday")).toEqual({
      start: "2026-10-11",
      end: "2026-10-17",
    });
    expect(submissionReminderWeek(on("2026-10-23", "friday"), "sunday")).toEqual({
      start: "2026-10-18",
      end: "2026-10-24",
    });
    // Saturday-start weeks.
    expect(submissionReminderWeek(on("2026-10-17", "saturday"), "saturday")).toEqual({
      start: "2026-10-10",
      end: "2026-10-16",
    });
  });

  it("[unit] crosses a month and a year end", () => {
    expect(submissionReminderWeek(on("2027-01-04", "monday"), "monday")).toEqual({
      start: "2026-12-28",
      end: "2027-01-03",
    });
  });
});

const links = {
  timesheet: "https://time.example.test/",
  preferences: "https://time.example.test/settings/user",
};

describe("the reminder messages (issue 935)", () => {
  it("[unit] says what was tracked against what is usual, and where to change the reminder", () => {
    const none = composeDailyTimeReminder({
      companyName: "CONFLICT",
      firstName: "Mo",
      date: "2026-10-14",
      trackedSeconds: 0,
      usualSeconds: 25_200,
      links,
    });
    expect(none.subject).toBe("Time reminder: log your hours for Wednesday, October 14");
    expect(none.text).toContain("You have not logged any time for Wednesday, October 14 yet.");
    expect(none.text).toContain("https://time.example.test/settings/user");

    const some = composeDailyTimeReminder({
      companyName: "CONFLICT",
      firstName: "Mo",
      date: "2026-10-14",
      trackedSeconds: 7_200,
      usualSeconds: 25_200,
      links,
    });
    expect(some.text).toContain("logged 2 hours for Wednesday, October 14, short of your usual 7 hours");
  });

  it("[unit] names the week to submit, and who has not submitted", () => {
    const week = { start: "2026-10-12", end: "2026-10-18" };
    const reminder = composeSubmissionReminder({ companyName: "CONFLICT", firstName: "Mo", week, links });
    expect(reminder.subject).toBe("Timesheet reminder: submit your week of Monday, October 12");
    expect(reminder.text).toContain("Monday, October 12 to Sunday, October 18");

    const one = composeSubmissionDigest({ companyName: "CONFLICT", firstName: "Pia", week, people: ["Mo Member"], links });
    expect(one.subject).toBe("Timesheet digest: 1 person has not submitted");
    const two = composeSubmissionDigest({
      companyName: "CONFLICT",
      firstName: "Pia",
      week,
      people: ["Mo Member", "Lee Member"],
      links,
    });
    expect(two.subject).toBe("Timesheet digest: 2 people have not submitted");
    expect(two.text).toContain("- Mo Member\n- Lee Member");
  });
});
