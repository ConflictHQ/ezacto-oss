import type { Hono } from "hono";
import { requireApiScope } from "./auth.js";
import type { ApiContext } from "./context.js";
import { notFound } from "./resources/support.js";

export interface ClientHierarchyNode {
  ancestorId: number;
  descendantId: number;
  depth: number;
}

export interface ClientTreeReader {
  ancestors(clientId: number): Promise<readonly ClientHierarchyNode[]>;
  descendants(clientId: number): Promise<readonly ClientHierarchyNode[]>;
}

const parseClientId = (raw: string): number => {
  if (!/^[1-9][0-9]*$/.test(raw)) throw notFound("client");
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) throw notFound("client");
  return id;
};

export const installClientTreeRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  tree: ClientTreeReader,
): void => {
  api.get("/clients/:id/ancestors", async (context) => {
    requireApiScope(context, "clients:read");
    const clientId = parseClientId(context.req.param("id"));
    const nodes = await tree.ancestors(clientId);
    if (nodes.length === 0) throw notFound("client");
    return context.json({
      data: nodes.map((node) => ({
        ancestor_id: node.ancestorId,
        descendant_id: node.descendantId,
        depth: node.depth,
      })),
      links: { self: `/api/v1/clients/${clientId}/ancestors` },
    });
  });

  api.get("/clients/:id/descendants", async (context) => {
    requireApiScope(context, "clients:read");
    const clientId = parseClientId(context.req.param("id"));
    const nodes = await tree.descendants(clientId);
    if (nodes.length === 0) throw notFound("client");
    return context.json({
      data: nodes.map((node) => ({
        ancestor_id: node.ancestorId,
        descendant_id: node.descendantId,
        depth: node.depth,
      })),
      links: { self: `/api/v1/clients/${clientId}/descendants` },
    });
  });
};
