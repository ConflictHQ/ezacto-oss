import type { GeneralResourceRepository } from "@ezacto/core";
import { describe, expect, it } from "vitest";
import {
  apiContractOperations,
  createApiApp,
  generateOpenApiDocument,
  installGeneralResourceRoutes,
  installTrackedResourceRoutes,
  type ApiTokenService,
  type TrackedResourceRepository,
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
const tokens = new Proxy(
  {},
  { get: () => unavailable },
) as ApiTokenService;

const documentedApp = () =>
  createApiApp({
    authentication: { tokens },
    installApi: (api) => {
      installGeneralResourceRoutes(api, {
        repository: generalRepository,
        cursorSigningKey: new Uint8Array(32),
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
      });
    },
  });

describe("OpenAPI contract", () => {
  it("[api] documents every mounted native API method exactly once", () => {
    const mounted = documentedApp().routes
      .filter(
        (route) =>
          route.method !== "ALL" && route.path.startsWith("/api/v1"),
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
  });
});
