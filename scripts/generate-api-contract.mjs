import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractModule = await import(
  pathToFileURL(resolve(root, "packages/api/dist/contract.js")).href
);

const document = contractModule.generateOpenApiDocument();
const operations = contractModule.apiContractOperations;
const schemas = contractModule.apiContractSchemas;
const openApi = `${JSON.stringify(document, null, 2)}\n`;

const schemaType = (schema) => {
  if (schema === undefined || schema === null) return "unknown";
  if (typeof schema.$ref === "string") return schema.$ref.split("/").at(-1);
  if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum))
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (Array.isArray(schema.anyOf))
    return schema.anyOf.map(schemaType).join(" | ");
  if (Array.isArray(schema.oneOf))
    return schema.oneOf.map(schemaType).join(" | ");
  if (Array.isArray(schema.allOf))
    return schema.allOf.map((entry) => `(${schemaType(entry)})`).join(" & ");
  if (schema.type === "array") return `Array<${schemaType(schema.items)}>`;
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "null") return "null";
  if (schema.type === "string") return "string";
  if (schema.type === "object" || schema.properties !== undefined) {
    const required = new Set(schema.required ?? []);
    const properties = Object.entries(schema.properties ?? {}).map(
      ([name, value]) =>
        `  ${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${schemaType(value)};`,
    );
    if (schema.additionalProperties === true)
      properties.push("  [key: string]: unknown;");
    else if (
      schema.additionalProperties !== undefined &&
      schema.additionalProperties !== false
    )
      properties.push(
        `  [key: string]: ${schemaType(schema.additionalProperties)};`,
      );
    return properties.length === 0
      ? "Record<string, unknown>"
      : `{\n${properties.join("\n")}\n}`;
  }
  return "unknown";
};

const typeDeclarations = Object.entries(schemas)
  .map(([name, schema]) => `export type ${name} = ${schemaType(schema)};`)
  .join("\n\n");

const queryType = (parameters) => {
  const queryParameters = (parameters ?? []).filter(
    (parameter) => parameter.location === "query",
  );
  if (queryParameters.length === 0) return null;
  return `{ ${queryParameters
    .map(
      (parameter) =>
        `${JSON.stringify(parameter.name)}${parameter.required === true ? "" : "?"}: ${schemaType(parameter.schema)}`,
    )
    .join("; ")} }`;
};

const methodSource = (operation) => {
  if (operation.generateClient === false) return null;
  const pathParameters = (operation.parameters ?? []).filter(
    (parameter) => parameter.location === "path",
  );
  const headerParameters = (operation.parameters ?? []).filter(
    (parameter) => parameter.location === "header",
  );
  const query = queryType(operation.parameters);
  const hasRequiredQuery = (operation.parameters ?? []).some(
    (parameter) =>
      parameter.location === "query" && parameter.required === true,
  );
  const argumentFields = [
    ...pathParameters.map(
      (parameter) =>
        `${JSON.stringify(parameter.name)}: ${schemaType(parameter.schema)}`,
    ),
    ...headerParameters.map(
      (parameter) =>
        `${JSON.stringify(parameter.name)}${parameter.required === true ? "" : "?"}: ${schemaType(parameter.schema)}`,
    ),
    ...(operation.requestSchema === undefined
      ? []
      : [
          `body: ${operation.requestContentType === "multipart/form-data" ? "FormData" : operation.requestSchema}`,
        ]),
    ...(query === null
      ? []
      : [`query${hasRequiredQuery ? "" : "?"}: ${query}`]),
    "signal?: AbortSignal",
    "headers?: HeadersInit",
  ];
  const requiresArguments =
    pathParameters.length > 0 ||
    operation.requestRequired === true ||
    headerParameters.some((parameter) => parameter.required === true) ||
    hasRequiredQuery;
  const argumentType = `{ ${argumentFields.join("; ")} }`;
  const signature = requiresArguments
    ? `args: ${argumentType}`
    : `args: ${argumentType} = {}`;
  const routeExpression = pathParameters.reduce(
    (expression, parameter) =>
      `${expression}.replace(${JSON.stringify(`:${parameter.name}`)}, encodeURIComponent(String(args[${JSON.stringify(parameter.name)}])))`,
    JSON.stringify(operation.path),
  );
  const responseType =
    operation.responseStatus === 204
      ? "void"
      : operation.binaryResponse === true
        ? "ArrayBuffer"
        : (operation.responseSchema ?? "unknown");
  const headerSource = headerParameters
    .map(
      (parameter) =>
        `    if (args[${JSON.stringify(parameter.name)}] !== undefined) headers.set(${JSON.stringify(parameter.name)}, String(args[${JSON.stringify(parameter.name)}]));`,
    )
    .join("\n");
  return `  async ${operation.operationId}(${signature}): Promise<${responseType}> {
    const headers = new Headers(args.headers);
${headerSource}
    return this.request<${responseType}>(${JSON.stringify(operation.method.toUpperCase())}, ${routeExpression}, {
      ${query === null ? "" : "query: args.query,\n      "}${operation.requestSchema === undefined ? "" : `body: args.body,\n      ${operation.requestContentType === "multipart/form-data" ? "multipart: true,\n      " : ""}`}signal: args.signal,
      ${operation.binaryResponse === true ? "binary: true,\n      " : ""}headers,
    });
  }`;
};

const methods = operations.map(methodSource).filter(Boolean).join("\n\n");

const client = `// Generated by scripts/generate-api-contract.mjs. Do not edit by hand.

${typeDeclarations}

export interface EzactoClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit;
}

export class EzactoApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly requestId: string | null;

  constructor(status: number, body: unknown, requestId: string | null) {
    super(\`ezacto API request failed with status \${status}\`);
    this.name = "EzactoApiError";
    this.status = status;
    this.body = body;
    this.requestId = requestId;
  }
}

interface RequestOptions {
  query?: Readonly<Record<string, string | number | boolean | undefined>> | undefined;
  body?: unknown;
  multipart?: boolean | undefined;
  binary?: boolean | undefined;
  signal?: AbortSignal | undefined;
  headers?: HeadersInit | undefined;
}

export class EzactoClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly defaultHeaders: Headers;

  constructor(options: EzactoClientOptions) {
    this.baseUrl = options.baseUrl.endsWith("/")
      ? options.baseUrl
      : \`\${options.baseUrl}/\`;
    this.token = options.token;
    // Bound, because this is stored on the instance and later called as
    // \`this.fetchImplementation(...)\`. A browser's fetch is a method of
    // Window and refuses any other receiver, so the unbound form threw
    // "Failed to execute 'fetch' on 'Window': Illegal invocation" on every
    // request from a page or an extension (#772). Binding whatever we are
    // given also covers a caller who hands us a bare \`globalThis.fetch\`;
    // an arrow or an already-bound function ignores the receiver anyway.
    this.fetchImplementation = (options.fetch ?? globalThis.fetch).bind(globalThis);
    this.defaultHeaders = new Headers(options.headers);
  }

  private async request<T>(
    method: string,
    path: string,
    options: RequestOptions,
  ): Promise<T> {
    const url = new URL(path.replace(/^\\//, ""), this.baseUrl);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const headers = new Headers(this.defaultHeaders);
    const requestHeaders = new Headers(options.headers);
    requestHeaders.forEach((value, name) => headers.set(name, value));
    if (this.token !== undefined) headers.set("authorization", \`Bearer \${this.token}\`);
    if (options.multipart === true) headers.delete("content-type");
    else if (options.body !== undefined) headers.set("content-type", "application/json");
    const response = await this.fetchImplementation(url, {
      method,
      headers,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.body === undefined
        ? {}
        : { body: options.multipart === true ? options.body as BodyInit : JSON.stringify(options.body) }),
    });
    if (response.ok && options.binary === true) return await response.arrayBuffer() as T;
    const text = await response.text();
    let body: unknown = undefined;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      throw new EzactoApiError(
        response.status,
        body,
        response.headers.get("x-request-id"),
      );
    }
    return body as T;
  }

${methods}
}
`;

const outputs = [
  [resolve(root, "openapi/ezacto-v1.openapi.json"), openApi],
  [resolve(root, "packages/client/src/generated.ts"), client],
];

const check = process.argv.includes("--check");
let drift = false;
for (const [target, content] of outputs) {
  if (check) {
    const existing = await readFile(target, "utf8").catch(() => null);
    if (existing !== content) {
      console.error(`generated contract drift: ${target}`);
      drift = true;
    }
  } else {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    console.log(`generated ${target}`);
  }
}
if (drift) {
  console.error("run npm run contract:generate and commit the result");
  process.exitCode = 1;
}
