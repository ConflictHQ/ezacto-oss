// Harvest stores a person's timezone as a Rails ActiveSupport::TimeZone *display
// name* -- "Central America", "Warsaw", "Pacific Time (US & Canada)" -- not as an
// IANA identifier. `Intl` refuses every one of them.
//
// Loading those strings straight through is how sixty imported people ended up
// with a timezone no calendar could use. Nothing rejected it at the door, and the
// breakage surfaced much later and far away: the repository preferred the personal
// zone, `Intl` threw, and the catch fell all the way back to UTC -- so every
// imported person filed their evening work on the wrong day, and the organization
// zone that would have been right was never consulted.
//
// So the door is here. A zone that survives this function is one a calendar can
// use; anything else is refused and recorded rather than stored.

/**
 * ActiveSupport::TimeZone::MAPPING, which is the exact list Harvest's people
 * settings offers. Several display names share a zone ("Osaka", "Sapporo" and
 * "Tokyo" are all Asia/Tokyo) because Rails names cities and IANA names zones.
 */
const HARVEST_TIMEZONES: ReadonlyMap<string, string> = new Map([
  ['International Date Line West', 'Etc/GMT+12'],
  ['Midway Island', 'Pacific/Midway'],
  ['American Samoa', 'Pacific/Pago_Pago'],
  ['Hawaii', 'Pacific/Honolulu'],
  ['Alaska', 'America/Juneau'],
  ['Pacific Time (US & Canada)', 'America/Los_Angeles'],
  ['Tijuana', 'America/Tijuana'],
  ['Mountain Time (US & Canada)', 'America/Denver'],
  ['Arizona', 'America/Phoenix'],
  ['Chihuahua', 'America/Chihuahua'],
  ['Mazatlan', 'America/Mazatlan'],
  ['Central Time (US & Canada)', 'America/Chicago'],
  ['Saskatchewan', 'America/Regina'],
  ['Guadalajara', 'America/Mexico_City'],
  ['Mexico City', 'America/Mexico_City'],
  ['Monterrey', 'America/Monterrey'],
  ['Central America', 'America/Guatemala'],
  ['Eastern Time (US & Canada)', 'America/New_York'],
  ['Indiana (East)', 'America/Indiana/Indianapolis'],
  ['Bogota', 'America/Bogota'],
  ['Lima', 'America/Lima'],
  ['Quito', 'America/Lima'],
  ['Atlantic Time (Canada)', 'America/Halifax'],
  ['Caracas', 'America/Caracas'],
  ['La Paz', 'America/La_Paz'],
  ['Santiago', 'America/Santiago'],
  ['Newfoundland', 'America/St_Johns'],
  ['Brasilia', 'America/Sao_Paulo'],
  ['Buenos Aires', 'America/Argentina/Buenos_Aires'],
  ['Montevideo', 'America/Montevideo'],
  ['Georgetown', 'America/Guyana'],
  ['Puerto Rico', 'America/Puerto_Rico'],
  ['Greenland', 'America/Godthab'],
  ['Mid-Atlantic', 'Atlantic/South_Georgia'],
  ['Azores', 'Atlantic/Azores'],
  ['Cape Verde Is.', 'Atlantic/Cape_Verde'],
  ['Dublin', 'Europe/Dublin'],
  ['Edinburgh', 'Europe/London'],
  ['Lisbon', 'Europe/Lisbon'],
  ['London', 'Europe/London'],
  ['Casablanca', 'Africa/Casablanca'],
  ['Monrovia', 'Africa/Monrovia'],
  ['UTC', 'Etc/UTC'],
  ['Belgrade', 'Europe/Belgrade'],
  ['Bratislava', 'Europe/Bratislava'],
  ['Budapest', 'Europe/Budapest'],
  ['Ljubljana', 'Europe/Ljubljana'],
  ['Prague', 'Europe/Prague'],
  ['Sarajevo', 'Europe/Sarajevo'],
  ['Skopje', 'Europe/Skopje'],
  ['Warsaw', 'Europe/Warsaw'],
  ['Zagreb', 'Europe/Zagreb'],
  ['Brussels', 'Europe/Brussels'],
  ['Copenhagen', 'Europe/Copenhagen'],
  ['Madrid', 'Europe/Madrid'],
  ['Paris', 'Europe/Paris'],
  ['Amsterdam', 'Europe/Amsterdam'],
  ['Berlin', 'Europe/Berlin'],
  ['Bern', 'Europe/Zurich'],
  ['Zurich', 'Europe/Zurich'],
  ['Rome', 'Europe/Rome'],
  ['Stockholm', 'Europe/Stockholm'],
  ['Vienna', 'Europe/Vienna'],
  ['West Central Africa', 'Africa/Algiers'],
  ['Bucharest', 'Europe/Bucharest'],
  ['Cairo', 'Africa/Cairo'],
  ['Helsinki', 'Europe/Helsinki'],
  ['Kyiv', 'Europe/Kiev'],
  ['Riga', 'Europe/Riga'],
  ['Sofia', 'Europe/Sofia'],
  ['Tallinn', 'Europe/Tallinn'],
  ['Vilnius', 'Europe/Vilnius'],
  ['Athens', 'Europe/Athens'],
  ['Istanbul', 'Europe/Istanbul'],
  ['Minsk', 'Europe/Minsk'],
  ['Jerusalem', 'Asia/Jerusalem'],
  ['Harare', 'Africa/Harare'],
  ['Pretoria', 'Africa/Johannesburg'],
  ['Kaliningrad', 'Europe/Kaliningrad'],
  ['Moscow', 'Europe/Moscow'],
  ['St. Petersburg', 'Europe/Moscow'],
  ['Volgograd', 'Europe/Volgograd'],
  ['Samara', 'Europe/Samara'],
  ['Kuwait', 'Asia/Kuwait'],
  ['Riyadh', 'Asia/Riyadh'],
  ['Nairobi', 'Africa/Nairobi'],
  ['Baghdad', 'Asia/Baghdad'],
  ['Tehran', 'Asia/Tehran'],
  ['Abu Dhabi', 'Asia/Muscat'],
  ['Muscat', 'Asia/Muscat'],
  ['Baku', 'Asia/Baku'],
  ['Tbilisi', 'Asia/Tbilisi'],
  ['Yerevan', 'Asia/Yerevan'],
  ['Kabul', 'Asia/Kabul'],
  ['Ekaterinburg', 'Asia/Yekaterinburg'],
  ['Islamabad', 'Asia/Karachi'],
  ['Karachi', 'Asia/Karachi'],
  ['Tashkent', 'Asia/Tashkent'],
  ['Chennai', 'Asia/Kolkata'],
  ['Kolkata', 'Asia/Kolkata'],
  ['Mumbai', 'Asia/Kolkata'],
  ['New Delhi', 'Asia/Kolkata'],
  ['Kathmandu', 'Asia/Kathmandu'],
  ['Astana', 'Asia/Dhaka'],
  ['Dhaka', 'Asia/Dhaka'],
  ['Sri Jayawardenepura', 'Asia/Colombo'],
  ['Almaty', 'Asia/Almaty'],
  ['Novosibirsk', 'Asia/Novosibirsk'],
  ['Rangoon', 'Asia/Rangoon'],
  ['Bangkok', 'Asia/Bangkok'],
  ['Hanoi', 'Asia/Bangkok'],
  ['Jakarta', 'Asia/Jakarta'],
  ['Krasnoyarsk', 'Asia/Krasnoyarsk'],
  ['Beijing', 'Asia/Shanghai'],
  ['Chongqing', 'Asia/Chongqing'],
  ['Hong Kong', 'Asia/Hong_Kong'],
  ['Urumqi', 'Asia/Urumqi'],
  ['Kuala Lumpur', 'Asia/Kuala_Lumpur'],
  ['Singapore', 'Asia/Singapore'],
  ['Taipei', 'Asia/Taipei'],
  ['Perth', 'Australia/Perth'],
  ['Irkutsk', 'Asia/Irkutsk'],
  ['Ulaanbaatar', 'Asia/Ulaanbaatar'],
  ['Seoul', 'Asia/Seoul'],
  ['Osaka', 'Asia/Tokyo'],
  ['Sapporo', 'Asia/Tokyo'],
  ['Tokyo', 'Asia/Tokyo'],
  ['Yakutsk', 'Asia/Yakutsk'],
  ['Darwin', 'Australia/Darwin'],
  ['Adelaide', 'Australia/Adelaide'],
  ['Canberra', 'Australia/Melbourne'],
  ['Melbourne', 'Australia/Melbourne'],
  ['Sydney', 'Australia/Sydney'],
  ['Brisbane', 'Australia/Brisbane'],
  ['Hobart', 'Australia/Hobart'],
  ['Vladivostok', 'Asia/Vladivostok'],
  ['Guam', 'Pacific/Guam'],
  ['Port Moresby', 'Pacific/Port_Moresby'],
  ['Magadan', 'Asia/Magadan'],
  ['Srednekolymsk', 'Asia/Srednekolymsk'],
  ['Solomon Is.', 'Pacific/Guadalcanal'],
  ['New Caledonia', 'Pacific/Noumea'],
  ['Fiji', 'Pacific/Fiji'],
  ['Kamchatka', 'Asia/Kamchatka'],
  ['Marshall Is.', 'Pacific/Majuro'],
  ['Auckland', 'Pacific/Auckland'],
  ['Wellington', 'Pacific/Auckland'],
  ["Nuku'alofa", 'Pacific/Tongatapu'],
  ['Tokelau Is.', 'Pacific/Fakaofo'],
  ['Chatham Is.', 'Pacific/Chatham'],
  ['Samoa', 'Pacific/Apia'],
])

/** Whether a calendar can actually be built on this zone. The only real test. */
export const usableTimezone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date(0))
    return true
  } catch {
    return false
  }
}

export interface NormalizedTimezone {
  /** An IANA zone `Intl` accepts, or the fallback when the source had none. */
  timezone: string
  /** Set when the source value was dropped, for the reconciliation report. */
  unmapped?: string
}

/**
 * The source value as an IANA zone, in three steps: already usable, a known
 * Harvest display name, or refused.
 *
 * A refused value does not stop the import. A timezone is a display preference;
 * losing a whole account's history over one unrecognised string would be a far
 * worse trade than filing that person against the fallback and saying so in the
 * report. The organization zone is the fallback that matters -- it is the answer
 * everyone had before personal zones existed.
 */
export const normalizeTimezone = (
  value: string | null,
  fallback: string,
): NormalizedTimezone => {
  const trimmed = value === null ? '' : value.trim()
  if (trimmed === '') return { timezone: fallback }
  // An IANA name wins on sight: a Harvest account edited through the API, or any
  // other source, can already hold one, and the display-name table must not
  // shadow it.
  if (usableTimezone(trimmed)) return { timezone: trimmed }
  const mapped = HARVEST_TIMEZONES.get(trimmed)
  // The table is checked against `Intl` too. A zone Rails still names but the
  // host's tzdata has since retired is no better than an unmapped one.
  if (mapped !== undefined && usableTimezone(mapped)) return { timezone: mapped }
  return { timezone: fallback, unmapped: trimmed }
}
