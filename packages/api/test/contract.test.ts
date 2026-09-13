import type { GeneralResourceRepository, TeamRepository } from "@ezacto/core";
import { describe, expect, it } from "vitest";
import {
  installBackupStatusRoutes,
  installQuickBooksRoutes,
  installWiseRoutes,
  installBrandAssetRoutes,
  installBrandRoute,
  installBillRoutes,
  installPayoutAccountRoutes,
  installInvoiceDocumentPreferenceRoutes,
  installThankYouPreferenceRoutes,
  installRecurringRepairRoutes,
  installInvoiceTimeClaimRoutes,
  installStripeRoutes,
  installInstanceThemeRoutes,
  apiContractOperations,
  createApiApp,
  generateOpenApiDocument,
  installAttachmentRoutes,
  installClientTreeRoutes,
  installEmailConfigurationRoutes,
  installEmailHealthRoutes,
  installEmailLogRoutes,
  installGeneralResourceRoutes,
  installModuleSettingsRoutes,
  installMoneyResourceRoutes,
  installOidcRoutes,
  installOutboxRoutes,
  installPasswordAuthRoutes,
  installReportRoutes,
  installSessionRoutes,
  installSsoDomainRoutes,
  installTwoFactorRoutes,
  installTrackedResourceRoutes,
  installTeamRoutes,
  installTimesheetApprovalRoutes,
  installTimesheetLockPolicyRoutes,
  installUserEmailRoutes,
  type RecurringGenerationPort,
  type TwoFactorService,
  type ApiSessionService,
  type ClientTreeReader,
  type EmailConfigurationService,
  type AuthMailer,
  type ApiTokenService,
  type BrandAssetSurface,
  type OidcIdentityResolver,
  type OidcTransactionStorePort,
  type OutboxMonitor,
  type PasswordAuthService,
  type ModuleSettingsService,
  type MoneyResourceRouteOptions,
  type ReportReader,
  type SsoProvisioningDomainService,
  type TrackedResourceRepository,
  type UserEmailService,
  type TimesheetApprovalService,
  type TimesheetLockPolicyService,
} from "../src/index.js";

const unavailable = () => Promise.reject(new Error("contract fixture only"));
const generalRepository = new Proxy(
  {},
  { get: () => unavailable },
) as GeneralResourceRepository;
const trackedRepository = new Proxy(
  {},
  { get: () => unavailable },
) as TrackedResourceRepository;
const timesheetApprovals = new Proxy(
  {},
  { get: () => unavailable },
) as TimesheetApprovalService;
const timesheetLockPolicy = new Proxy(
  {},
  { get: () => unavailable },
) as TimesheetLockPolicyService;
const moneyResources = new Proxy(
  {},
  { get: () => unavailable },
) as MoneyResourceRouteOptions["service"];
const reports = new Proxy({}, { get: () => unavailable }) as ReportReader;
const moduleSettings = new Proxy(
  {},
  { get: () => unavailable },
) as ModuleSettingsService;
const ssoDomains = new Proxy(
  {},
  { get: () => unavailable },
) as SsoProvisioningDomainService;
const userEmails = new Proxy(
  {},
  { get: () => unavailable },
) as UserEmailService;
const twoFactor = new Proxy({}, { get: () => unavailable }) as TwoFactorService;
const brandAssets = new Proxy(
  {},
  { get: () => unavailable },
) as BrandAssetSurface<object>;
const recurringGeneration = new Proxy(
  {},
  { get: () => unavailable },
) as RecurringGenerationPort;
const team = new Proxy({}, { get: () => unavailable }) as TeamRepository;
const treeReader = new Proxy({}, { get: () => unavailable }) as ClientTreeReader;
const tokens = new Proxy({}, { get: () => unavailable }) as ApiTokenService;
const passwordAuth = new Proxy(
  {},
  { get: () => unavailable },
) as PasswordAuthService;
const authMailer = new Proxy({}, { get: () => unavailable }) as AuthMailer;
const sessions = new Proxy({}, { get: () => unavailable }) as ApiSessionService;
const emailLog = { list: unavailable, countByStatus: unavailable };
const emailConfiguration = new Proxy(
  {},
  { get: () => unavailable },
) as EmailConfigurationService;
const outbox = new Proxy({}, { get: () => unavailable }) as OutboxMonitor;
const identities = new Proxy(
  {},
  { get: () => unavailable },
) as OidcIdentityResolver;
const oidcTransactions = new Proxy(
  {},
  { get: () => unavailable },
) as OidcTransactionStorePort;

const documentedApp = () =>
  createApiApp({
    authentication: { tokens, sessions },
    installApp: (app) => {
      installOidcRoutes(app, {
        transactions: oidcTransactions,
        identities,
        sessions,
        provider: () => null,
        clientKey: () => "contract-fixture",
      });
      installPasswordAuthRoutes(app, {
        service: passwordAuth,
        sessions: { issue: unavailable },
        deploymentMailer: authMailer,
        clientKey: () => "contract-fixture",
      });
    },
    installApi: (api) => {
      installSessionRoutes(api, sessions);
      installQuickBooksRoutes(api, {
        clientId: () => "contract-fixture",
        callbackUrl: () => "https://app.example.test/cb",
        settingsUrl: () => "/settings/integrations",
        authorizeUrl: () => "https://appcenter.intuit.com/connect/oauth2",
        beginAuthorization: async () => undefined,
        completeAuthorization: async () => {
          throw new Error("not used by the contract fixture");
        },
        readStatus: async () => null,
        setAllowOnlinePayment: async () => undefined,
        disconnect: async () => undefined,
        receiveWebhook: async () => ({ accepted: true }),
        newState: () => "contract-fixture-state",
      });
      installWiseRoutes(api, {
        clientId: () => "contract-fixture",
        callbackUrl: () => "https://app.example.test/cb",
        settingsUrl: () => "/settings/payouts",
        authorizeUrl: () => "https://sandbox.wise.com/oauth/authorize",
        beginAuthorization: async () => undefined,
        completeAuthorization: async () => {
          throw new Error("not used by the contract fixture");
        },
        readStatus: async () => null,
        disconnect: async () => false,
        newState: () => "contract-fixture-state",
      });
      installEmailLogRoutes(api, emailLog);
      installEmailHealthRoutes(api, emailLog);
      installEmailConfigurationRoutes(api, {
        service: emailConfiguration,
        clock: () => "2026-08-28T12:00:00.000Z",
      });
      installOutboxRoutes(api, outbox);
      installGeneralResourceRoutes(api, {
        repository: generalRepository,
        cursorSigningKey: new Uint8Array(32),
        isExpensesModuleEnabled: async () => true,
        teamRepository: team,
      });
      installTrackedResourceRoutes(api, {
        repository: trackedRepository,
        cursorSigningKey: new Uint8Array(32),
        clock: {
          now: () => ({
            instant: "2026-08-28T12:00:00.000Z",
            date: "2026-08-28",
            time: "12:00",
          }),
        },
        isExpensesModuleEnabled: async () => true,
      });
      installTimesheetApprovalRoutes(api, {
        service: timesheetApprovals,
        cursorSigningKey: new Uint8Array(32),
        clock: () => "2026-08-28T12:00:00.000Z",
      });
      installTimesheetLockPolicyRoutes(api, {
        service: timesheetLockPolicy,
        cursorSigningKey: new Uint8Array(32),
        clock: () => "2026-08-28T12:00:00.000Z",
      });
      installMoneyResourceRoutes(api, {
        service: moneyResources,
        cursorSigningKey: new Uint8Array(32),
        recurringGeneration: recurringGeneration,
      });
      installAttachmentRoutes(api);
      installReportRoutes(api, reports);
      installModuleSettingsRoutes(api, {
        service: moduleSettings,
        clock: () => "2026-08-28T12:00:00.000Z",
      });
      installSsoDomainRoutes(api, {
        service: ssoDomains,
        clock: () => "2026-08-28T12:00:00.000Z",
      });
      installBrandAssetRoutes(api, brandAssets, () => "2026-08-28T12:00:00.000Z");
      installBrandRoute(api, {
        organizationName: async () => "Contract Fixture",
        assets: (env) => brandAssets.list(env),
      });
      installStripeRoutes(api, {
        configured: () => false,
        paymentLink: async () => ({ kind: "refused", reason: "fixture" }),
        receiveWebhook: async () => ({ kind: "unverified" }),
      });
      installInvoiceDocumentPreferenceRoutes(api, {
        readInvoicePreference: async () => ({ invoice: null, organization: false }),
        setInvoicePreference: async () => true,
        readOrganizationPreference: async () => false,
        setOrganizationPreference: async () => undefined,
        readInvoiceJournal: async () => ({ invoice: null, organization: false }),
        setInvoiceJournal: async () => true,
        readOrganizationJournal: async () => false,
        setOrganizationJournal: async () => undefined,
      } as never);
      installRecurringRepairRoutes(
        api,
        { listIncomplete: async () => [], complete: async () => ({ outcome: 'completed' }) } as never,
        () => "2026-09-12T12:00:00.000Z",
      );
      installThankYouPreferenceRoutes(api, {
        readInvoiceThankYou: async () => ({ invoice: null, organization: false }),
        setInvoiceThankYou: async () => true,
        readOrganizationThankYou: async () => false,
        setOrganizationThankYou: async () => undefined,
      } as never);
      installInvoiceTimeClaimRoutes(api, {
        releaseInvoicedTime: async () => ({ kind: "released", released: 0 }),
      });
      installPayoutAccountRoutes(api, {
        listForUser: async () => [],
        link: async () => ({ outcome: "unknown_user" }),
        read: async () => null,
        detach: async () => false,
      });
      installBillRoutes(api, {
        status: () => ({
          configured: false,
          companyId: null,
          environment: "sandbox",
          canSendFromBill: false,
        }),
        isOptedIn: async () => false,
        setOptedIn: async () => false,
      });
      installInstanceThemeRoutes(api, {
        surface: {
          read: async () => null,
          write: async () => ({ palette: {}, updatedAt: "2026-08-28T12:00:00.000Z" }),
          clear: async () => false,
        },
        contract: { slots: ["ground"], base: { ground: "#FFFFFF" }, requirements: [] },
        clock: () => "2026-08-28T12:00:00.000Z",
      });
      installUserEmailRoutes(api, {
        service: userEmails,
        deploymentMailer: authMailer,
        clientKey: () => "contract-fixture",
      });
      installTwoFactorRoutes(api, twoFactor);
      installTeamRoutes(api, {
        repository: team,
        cursorSigningKey: new Uint8Array(32),
        isTeamModuleEnabled: async () => true,
      });
      installClientTreeRoutes(api, treeReader);
      // Mounted only where a deployment composes a reader -- the Worker does,
      // the container does not (`entry-surface.ts`). The fixture composes one so
      // the documented operation has something to be checked against.
      installBackupStatusRoutes(api, { latestRuns: async () => [] });
    },
  });

describe("OpenAPI contract", () => {
  it("[api] documents every mounted native API method exactly once", () => {
    const mounted = documentedApp()
      .routes.filter(
        (route) =>
          route.method !== "ALL" &&
          (route.path.startsWith("/api/v1") || route.path.startsWith("/auth")),
      )
      .map((route) => `${route.method.toLowerCase()} ${route.path}`)
      .sort();
    const documented = apiContractOperations
      .map((operation) => `${operation.method} ${operation.path}`)
      .sort();

    expect(new Set(mounted).size).toBe(mounted.length);
    expect(new Set(documented).size).toBe(documented.length);
    expect(documented).toEqual(mounted);
  });

  it("[unit] generates a deterministic, internally linked OpenAPI document", () => {
    const first = generateOpenApiDocument();
    const second = generateOpenApiDocument();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const operationIds = apiContractOperations.map(
      (operation) => operation.operationId,
    );
    expect(new Set(operationIds).size).toBe(operationIds.length);

    const schemas = (
      first.components as {
        schemas: Record<string, unknown>;
      }
    ).schemas;
    const references = JSON.stringify(first).matchAll(
      /#\/components\/schemas\/([A-Za-z0-9]+)/g,
    );
    for (const reference of references)
      expect(schemas, reference[1]).toHaveProperty(reference[1]!);

    const paths = first.paths as Record<
      string,
      Record<string, { responses: Record<string, unknown> }>
    >;
    expect(
      paths["/api/v1/timesheet-submissions"]?.post?.responses,
    ).toMatchObject({ "200": expect.any(Object), "201": expect.any(Object) });
    expect(
      paths["/api/v1/timesheet-submissions/{id}"]?.get?.responses,
    ).toMatchObject({ "200": expect.any(Object) });
    expect(schemas).toHaveProperty("TimesheetSubmissionDetail");
    expect(schemas).toHaveProperty("TimesheetSubmissionEntry");

    const categoryCollection = paths["/api/v1/expense-categories"] as
      | {
          get?: {
            operationId: string;
            security: Array<Record<string, unknown>>;
            parameters: Array<{ name: string }>;
          };
          post?: {
            operationId: string;
            security: Array<Record<string, unknown>>;
          };
        }
      | undefined;
    expect(categoryCollection?.get).toMatchObject({
      operationId: "listExpenseCategories",
      security: [{ bearerAuth: [] }, { cookieSession: [] }],
      parameters: expect.arrayContaining([
        expect.objectContaining({ name: "is_active" }),
        expect.objectContaining({ name: "updated_since" }),
      ]),
    });
    expect(categoryCollection?.post).toMatchObject({
      operationId: "createExpenseCategory",
      security: [{ cookieSession: [] }],
    });
  });

  it("[contract] documents exact durable and discriminated money request shapes", () => {
    const document = generateOpenApiDocument() as {
      paths: Record<
        string,
        Record<string, { parameters?: Array<{ name: string }> }>
      >;
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    for (const [path, method] of [
      ["/api/v1/retainers", "post"],
      ["/api/v1/recurring-invoices", "post"],
      ["/api/v1/invoices/{invoiceId}/attachments", "post"],
      ["/api/v1/recurring-invoices/{recurringInvoiceId}/attachments", "post"],
      ["/api/v1/estimates/{estimateId}/attachments", "post"],
      ["/api/v1/expenses/{expenseId}/attachments", "post"],
      ["/api/v1/projects/{projectId}/attachments", "post"],
    ] as const) {
      expect(document.paths[path]?.[method]?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "Idempotency-Key" }),
        ]),
      );
    }

    const schemas = document.components.schemas;
    expect(schemas.RetainerInput?.oneOf as unknown[]).toHaveLength(3);
    expect(schemas.RetainerLedgerInput?.oneOf as unknown[]).toHaveLength(10);
    expect(schemas.RetainerDrawdownInput?.oneOf as unknown[]).toHaveLength(2);
    expect(schemas.InvoicePaymentInput?.oneOf as unknown[]).toHaveLength(2);
    const paymentUpdates = schemas.InvoicePaymentUpdateInput?.oneOf as Array<{
      properties: Record<string, unknown>;
      required: string[];
    }>;
    expect(paymentUpdates).toHaveLength(2);
    expect(
      paymentUpdates.every(({ properties }) => !("currency" in properties)),
    ).toBe(true);
    expect(paymentUpdates.map(({ required }) => required)).toEqual([
      expect.arrayContaining(["paid_at"]),
      expect.arrayContaining(["paid_date"]),
    ]);

    const reminder = schemas.InvoiceReminderPolicy as {
      required: string[];
      additionalProperties: boolean;
    };
    expect(reminder).toMatchObject({
      required: ["first_after_days", "every_days"],
      additionalProperties: false,
    });

    const recurring = schemas.RecurringAmountConfig?.oneOf as Array<{
      properties: Record<string, { minItems?: number }>;
      required: string[];
    }>;
    expect(recurring).toHaveLength(4);
    expect(recurring[0]?.properties.line_items?.minItems).toBe(1);
    expect(
      recurring
        .slice(1)
        .every(({ properties }) => properties.project_ids?.minItems === 1),
    ).toBe(true);
    expect(recurring.slice(1).map(({ required }) => required)).toEqual([
      expect.arrayContaining(["time"]),
      expect.arrayContaining(["expenses"]),
      expect.arrayContaining(["time", "expenses"]),
    ]);
  });

  it("[contract] documents safe legacy rate commands and inactive notification delivery", () => {
    const document = generateOpenApiDocument() as {
      paths: Record<
        string,
        Record<string, { parameters?: Array<{ name: string }> }>
      >;
      components: {
        schemas: Record<
          string,
          {
            required?: string[];
            properties?: Record<string, { enum?: unknown[]; $ref?: string }>;
          }
        >;
      };
    };
    for (const path of [
      "/api/v1/users/{userId}/billable-rates",
      "/api/v1/users/{userId}/cost-rates",
    ]) {
      expect(document.paths[path]?.post?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "Idempotency-Key" }),
        ]),
      );
    }
    expect(document.components.schemas.UserRateInput?.required).toEqual(
      expect.arrayContaining(["expected_version", "amount_cents"]),
    );
    const notifications = document.components.schemas.TeamNotificationInput;
    expect(notifications?.properties?.daily_reminder_enabled?.enum).toEqual([
      false,
    ]);
    expect(notifications?.properties?.channels?.$ref).toBe(
      "#/components/schemas/TeamInactiveNotificationChannels",
    );
    for (const property of ["email", "desktop", "slack"]) {
      expect(
        document.components.schemas.TeamInactiveNotificationChannels
          ?.properties?.[property]?.enum,
      ).toEqual([false]);
    }
  });
});
