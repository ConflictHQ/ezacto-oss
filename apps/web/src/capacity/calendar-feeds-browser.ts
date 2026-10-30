import type {
  CalendarFeed,
  CalendarFeedInput,
  CalendarFeedIssued,
} from "@conflict-hq/ezacto-client";
export interface CalendarFeedsApi {
  list(signal: AbortSignal): Promise<readonly CalendarFeed[]>;
  create(
    input: CalendarFeedInput,
    signal: AbortSignal,
  ): Promise<CalendarFeedIssued["data"]>;
  rotate(id: string, signal: AbortSignal): Promise<CalendarFeedIssued["data"]>;
  revoke(id: string, signal: AbortSignal): Promise<unknown>;
  download(id: string, signal: AbortSignal): Promise<Blob>;
}
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
};
export const createCalendarFeedsController = (
  host: HTMLElement,
  api: CalendarFeedsApi,
) => {
  const root = node("details");
  root.dataset.calendarFeeds = "";
  root.appendChild(node("summary", "Calendar subscriptions"));
  const intro = node(
    "p",
    "Publish an advisory, all-day calendar of weekly planned hours and available capacity. It contains no tracked time, rates, money, private notes or leave reasons. Subscriptions expire after 30 days. Use a calendar app that supports username/password ICS subscriptions. Partial weeks count their full weekly plan; partial-day leave changes availability only.",
  );
  const form = node("form");
  form.className = "capacity-form";
  const label = (title: string, input: Node) => {
    const el = node("label", title);
    (input as HTMLInputElement).setAttribute("aria-label",title);
    el.appendChild(input);
    form.appendChild(el);
  };
  const scope = node("select");
  scope.name = "scope";
  for (const [value, text] of [
    ["self", "My planning"],
    ["project", "Current project"],
    ["team", "Managed team"],
  ] as const) {
    const option = node("option", text);
    option.value = value;
    scope.appendChild(option);
  }
  label("Scope", scope);
  const from = node("input");
  from.type = "date";
  from.name = "from_date";
  from.required = true;
  label("First day", from);
  const through = node("input");
  through.type = "date";
  through.name = "through_date";
  through.required = true;
  label("Last day", through);
  const names = node("input");
  names.type = "checkbox";
  names.name = "include_names";
  label("Include permitted person and role names", names);
  const submit = node("button", "Create subscription");
  submit.type = "submit";
  form.appendChild(submit);
  const status = node("p");
  status.className = "form-result calendar-feed-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const secret = node("section");
  secret.hidden = true;
  secret.dataset.calendarFeedSecret = "";
  const list = node("div");
  list.dataset.calendarFeedList = "";
  for (const child of [intro, form, status, secret, list]) root.appendChild(child);
  host.appendChild(root);
  let signal: AbortSignal | null = null,
    epoch = 0,
    busy = false,
    projectId: number | null = null,
    manage = false;
  const current = (version: number) =>
    version === epoch && signal !== null && !signal.aborted;
  const controls = () => {
    for (const control of root.querySelectorAll<
      HTMLButtonElement
    >("button,input,select"))
      control.disabled = busy || signal === null || signal.aborted;
    for (const option of scope.options)
      option.disabled =
        option.value !== "self" &&
        (!manage || (option.value === "project" && projectId === null));
  };
  const showSecret = (issued: CalendarFeedIssued["data"]) => {
    secret.replaceChildren(
      node("h3", "Subscription credentials — shown once"),
      node(
        "p",
        "Subscribe to this URL in your calendar app, then enter the separate username and password when prompted. Never put credentials in the URL. Rotation replaces the password immediately. Revocation stops future access; existing downloaded copies may remain.",
      ),
    );
    for (const [title, value, hidden] of [
      ["URL", new URL("/calendar/planning.ics", location.origin).href, false],
      ["Username", issued.username, false],
      ["Password", issued.password, true],
    ] as const) {
      const field = node("label", title),
        input = node("input");
      input.readOnly = true;
      input.value = value;
      input.type = hidden ? "password" : "text";
      field.appendChild(input);
      const copy = node("button", `Copy ${title.toLowerCase()}`);
      copy.type = "button";
      copy.addEventListener("click", () => {
        const version = epoch;
        void navigator.clipboard.writeText(value).then(
          () => {
            if (current(version)) status.textContent = `${title} copied.`;
          },
          () => {
            if (current(version))
              status.textContent = "Select the field and copy it manually.";
          },
        );
      });
      field.appendChild(copy);
      if (hidden) {
        const reveal = node("button", "Show password");
        reveal.type = "button";
        reveal.addEventListener("click", () => {
          input.type = input.type === "password" ? "text" : "password";
          reveal.textContent =
            input.type === "password" ? "Show password" : "Hide password";
        });
        field.appendChild(reveal);
      }
      secret.appendChild(field);
    }
    secret.hidden = false;
  };
  const refresh = async (version: number) => {
    const rows = await api.list(signal!);
    if (!current(version)) return;
    list.replaceChildren();
    if (!rows.length) list.appendChild(node("p", "No calendar subscriptions yet."));
    for (const row of rows) {
      const item = node("article");
      item.dataset.calendarFeedId = row.id;
      item.replaceChildren(
        node(
          "h3",
          row.scope === "self"
            ? "My planning"
            : row.scope === "team"
              ? "Managed team"
              : `Project ${row.project_id}`,
        ),
        node(
          "p",
          `${row.from_date} to ${row.through_date} · ${row.include_names ? "names included" : "names omitted"} · ${row.revoked_at ? "Revoked" : `Expires ${row.expires_at.slice(0, 10)}`}`,
        ),
      );
      const button = (text: string, action: () => Promise<void>) => {
        const b = node("button", text);
        b.type = "button";
        b.addEventListener("click", () => void run(text, action));
        item.appendChild(b);
      };
      if (!row.revoked_at)
        button("Download calendar", async () => {
          const blob = await api.download(row.id, signal!);
          if (!current(version)) return;
          const url = URL.createObjectURL(blob),
            a = node("a");
          a.href = url;
          a.download = "ezacto-planning.ics";
          a.click();
          URL.revokeObjectURL(url);
        });
      button("Rotate password", async () => {
        const issued = await api.rotate(row.id, signal!);
        if (current(version)) showSecret(issued);
      });
      if (!row.revoked_at)
        button("Revoke subscription", async () => {
          await api.revoke(row.id, signal!);
          if (current(version)) {
            secret.replaceChildren();
            secret.hidden = true;
          }
        });
      list.appendChild(item);
    }
  };
  const run = async (title: string, action: () => Promise<void>) => {
    if (busy || !signal || signal.aborted) return;
    const version = epoch;
    busy = true;
    controls();
    status.textContent = `${title}…`;
    status.setAttribute("aria-busy", "true");
    try {
      await action();
      if (current(version)) {
        await refresh(version);
        if (current(version)) status.textContent = `${title} completed.`;
      }
    } catch (error) {
      if (current(version))
        status.textContent =
          error instanceof Error
            ? error.message
            : "The calendar request could not complete.";
    } finally {
      if (current(version)) {
        busy = false;
        status.setAttribute("aria-busy", "false");
        controls();
      }
    }
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void run("Create subscription", async () => {
      const version = epoch,
        issued = await api.create(
          {
            scope: scope.value as CalendarFeedInput["scope"],
            project_id: scope.value === "project" ? projectId : null,
            from_date: from.value,
            through_date: through.value,
            include_names: names.checked,
          },
          signal!,
        );
      if (current(version)) showSecret(issued);
    });
  });
  controls();
  return {
    context(range: { from: string; to: string; project_id?: number } | null) {
      projectId = range?.project_id ?? null;
      if (!from.value) from.value = range?.from ?? "";
      if (!through.value) through.value = range?.to ?? "";
      controls();
    },
    clear() {
      epoch++;
      signal = null;
      busy = false;
      secret.replaceChildren();
      secret.hidden = true;
      list.replaceChildren();
      status.textContent = "";
      status.setAttribute("aria-busy", "false");
      from.value = "";
      through.value = "";
      scope.value = "self";
      names.checked = false;
      controls();
    },
    async activate(
      active: AbortSignal,
      manager: boolean,
      range: { from: string; to: string; project_id?: number } | null,
    ) {
      if (signal !== active) {
        this.clear();
        signal = active;
        const ownedEpoch = epoch;
        active.addEventListener(
          "abort",
          () => {
            if (epoch === ownedEpoch) this.clear();
          },
          { once: true },
        );
      }
      manage = manager;
      projectId = range?.project_id ?? null;
      if (!from.value) from.value = range?.from ?? "";
      if (!through.value) through.value = range?.to ?? "";
      controls();
      await run("Load subscriptions", async () => {});
    },
  };
};
