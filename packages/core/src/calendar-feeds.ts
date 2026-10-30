export interface CalendarFeedAuthority {
  userId: number;
  sessionId: number;
}
export interface CalendarFeedInput {
  scope: "self" | "project" | "team";
  project_id: number | null;
  from_date: string;
  through_date: string;
  include_names: boolean;
  expires_at?: string;
}
export interface CalendarFeedDescriptor extends Omit<
  CalendarFeedInput,
  "expires_at"
> {
  id: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  credential_generation: number;
}
export interface CalendarFeedIssued {
  feed: CalendarFeedDescriptor;
  username: string;
  password: string;
}
export interface CalendarFeedService {
  list(
    authority: CalendarFeedAuthority,
  ): Promise<readonly CalendarFeedDescriptor[]>;
  create(
    authority: CalendarFeedAuthority,
    input: CalendarFeedInput,
  ): Promise<CalendarFeedIssued>;
  rotate(
    authority: CalendarFeedAuthority,
    id: string,
  ): Promise<CalendarFeedIssued>;
  revoke(authority: CalendarFeedAuthority, id: string): Promise<void>;
  download(authority: CalendarFeedAuthority, id: string): Promise<string>;
  subscribe(id: string, password: string): Promise<string>;
}
export class CalendarFeedError extends Error {
  constructor(
    readonly code:
      "invalid" | "forbidden" | "not_found" | "conflict" | "rate_limited",
    message = "This advisory calendar is unavailable.",
  ) {
    super(message);
    this.name = "CalendarFeedError";
  }
}
