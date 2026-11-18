import { query, transaction } from "../IdentityAcess_Services/Config/db.ts";
import { ApiError } from "../IdentityAcess_Services/Utils/http.ts";

/**
 * The companies and banks each investigator works for. No rows means every client; once head
 * office picks some, dispatch offers that investigator only cases of those clients.
 */

/** SQL condition: the investigator `userExpr` works for client `clientExpr`. */
export const WORKS_FOR_CLIENT_SQL = (userExpr: string, clientExpr: string) =>
  `(NOT EXISTS (SELECT 1 FROM investigator_clients ic WHERE ic.user_id = ${userExpr})
    OR EXISTS (SELECT 1 FROM investigator_clients ic WHERE ic.user_id = ${userExpr} AND ic.client_id = ${clientExpr}))`;

export async function clientsOf(userId: string): Promise<string[]> {
  const rows = await query("SELECT client_id FROM investigator_clients WHERE user_id = $1 ORDER BY client_id", [userId]);
  return rows.map((row) => row.client_id as string);
}

export async function allClients() {
  return query("SELECT client_id, name, client_type FROM form_clients WHERE active ORDER BY client_type, name");
}

/** Reads `client_ids` from a request body: undefined when absent, else a clean list. */
export function parseClientIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id.trim() || id.length > 64)) {
    throw ApiError.badRequest("client_ids must be a list of client ids", { field: "client_ids" });
  }
  return [...new Set(value.map((id: string) => id.trim()))];
}

/** Replaces the investigator's clients. An empty list means every client. */
export async function assertClientsExist(clientIds: string[]): Promise<void> {
  if (!clientIds.length) return;
  const known = await query("SELECT client_id FROM form_clients WHERE client_id = ANY($1::text[])", [clientIds]);
  if (known.length !== clientIds.length) {
    throw ApiError.badRequest("One of the chosen companies or banks does not exist", { field: "client_ids" });
  }
}

export async function setClientsOf(userId: string, clientIds: string[], actorId: string): Promise<string[]> {
  await assertClientsExist(clientIds);
  await transaction(async () => {
    await query("DELETE FROM investigator_clients WHERE user_id = $1 AND NOT (client_id = ANY($2::text[]))", [userId, clientIds]);
    await query(
      `INSERT INTO investigator_clients (user_id, client_id, added_by)
       SELECT $1, c, $3 FROM unnest($2::text[]) AS c ON CONFLICT DO NOTHING`,
      [userId, clientIds, actorId],
    );
  });
  return clientsOf(userId);
}
