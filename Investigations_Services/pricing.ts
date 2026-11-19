import { canonicalNames } from "../Shared/places.ts";
import { query } from "../IdentityAcess_Services/Config/db.ts";
import { withPermission } from "../IdentityAcess_Services/MIddlewares/auth.middleware.ts";
import { recordAudit } from "../IdentityAcess_Services/Services/audit.service.ts";
import { PERMISSIONS } from "../IdentityAcess_Services/Services/rbac.service.ts";
import { ApiError, ok, readJson } from "../IdentityAcess_Services/Utils/http.ts";
import type { Router } from "../IdentityAcess_Services/Utils/router.ts";
import { optionalNumber, optionalText, requiredText } from "../Shared/service.ts";
import { nameKey } from "../Shared/work-area.ts";

/**
 * Prices per company/bank and per area, set by head office.
 *
 * A rule prices one investigation type, optionally for one client and optionally for one
 * governorate or one district in it. For a case, the most specific matching rule wins:
 *   client + district > client + governorate > client (all areas)
 *   > district (all clients) > governorate (all clients) > the type's own prices.
 */

type Row = Record<string, unknown>;

export interface PriceRule {
  rule_id: string;
  service_level: string;
  client_id: string | null;
  governorate_key: string | null;
  district_key: string | null;
  client_price: number;
  investigator_price: number;
}

export interface Quote {
  client_price: number;
  investigator_price: number;
  rule_id: string | null;
  /** How the price was chosen, for the admin: «بنك مصر · الجيزة - الدقي». */
  basis: "client_district" | "client_governorate" | "client" | "district" | "governorate" | "default";
}

/** How specific a matching rule is (higher wins), or -1 when it does not apply to the case. */
export function ruleScore(
  rule: Pick<PriceRule, "client_id" | "governorate_key" | "district_key">,
  clientId: string | null,
  governorateKey: string | null,
  districtKey: string | null,
): number {
  if (rule.client_id && rule.client_id !== clientId) return -1;
  if (rule.governorate_key && rule.governorate_key !== governorateKey) return -1;
  if (rule.district_key && rule.district_key !== districtKey) return -1;
  const area = rule.district_key ? 2 : rule.governorate_key ? 1 : 0;
  return (rule.client_id ? 10 : 0) + area;
}

/** The winning rule among those for one type, or null for the type's own prices. */
export function pickRule<T extends Pick<PriceRule, "client_id" | "governorate_key" | "district_key">>(
  rules: T[],
  clientId: string | null,
  governorate: string | null,
  district: string | null,
): T | null {
  const governorateKey = governorate ? nameKey(governorate) : null;
  const districtKey = district ? nameKey(district) : null;
  let best: T | null = null;
  let bestScore = -1;
  for (const rule of rules) {
    const score = ruleScore(rule, clientId, governorateKey, districtKey);
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }
  return bestScore >= 0 ? best : null;
}

function basisOf(rule: Pick<PriceRule, "client_id" | "governorate_key" | "district_key"> | null): Quote["basis"] {
  if (!rule) return "default";
  if (rule.client_id) return rule.district_key ? "client_district" : rule.governorate_key ? "client_governorate" : "client";
  return rule.district_key ? "district" : rule.governorate_key ? "governorate" : "default";
}

/** The prices for a case: the most specific matching rule, else the type's own prices. */
export async function quotePrice(
  level: Row,
  clientId: string | null,
  governorate: string | null,
  district: string | null,
): Promise<Quote> {
  const rules = (await query(
    `SELECT rule_id, service_level, client_id, governorate_key, district_key,
       client_price::float8 AS client_price, investigator_price::float8 AS investigator_price
     FROM price_rules WHERE active AND service_level = $1 AND (client_id IS NULL OR client_id = $2)`,
    [level.code, clientId],
  )) as unknown as PriceRule[];
  const rule = pickRule(rules, clientId, governorate, district);
  return rule
    ? { client_price: rule.client_price, investigator_price: rule.investigator_price, rule_id: rule.rule_id, basis: basisOf(rule) }
    : {
        client_price: Number(level.client_price ?? 0),
        investigator_price: Number(level.investigator_price ?? 0),
        rule_id: null,
        basis: "default",
      };
}

const RULE_COLUMNS = `r.rule_id, r.service_level, r.client_id, c.name AS client_name, r.governorate, r.district,
  r.client_price::float8 AS client_price, r.investigator_price::float8 AS investigator_price, r.note, r.updated_at,
  u.full_name AS updated_by_name`;

const money = (body: Row, field: string) => {
  const value = optionalNumber(body[field], field);
  if (value === null) throw ApiError.badRequest(`${field} is required`, { field });
  if (value < 0 || value > 1_000_000) throw ApiError.badRequest(`${field} must be between 0 and 1,000,000`, { field });
  return value;
};

export function registerPricingRoutes(router: Router): void {
  /** What the admin's "send a case" screen shows for the chosen type, client and area. */
  router.get(
    "/investigations/price-quote",
    withPermission(PERMISSIONS.INVESTIGATIONS_MANAGE, async (context) => {
      const params = context.url.searchParams;
      const [level] = await query(
        "SELECT code, client_price::float8 AS client_price, investigator_price::float8 AS investigator_price FROM service_levels WHERE code = $1",
        [params.get("service_level") ?? ""],
      );
      if (!level) throw ApiError.badRequest("Choose an investigation type", { field: "service_level" });
      return ok({
        quote: await quotePrice(level, params.get("client_id") || null, params.get("governorate") || null, params.get("district") || null),
      });
    }),
  );

  /** Head office: every type with its default prices, every rule, and the clients to price. */
  router.get(
    "/investigations/pricing",
    withPermission(PERMISSIONS.PRICING_MANAGE, async () => {
      const [levels, rules, clients] = await Promise.all([
        query(
          `SELECT code, name_ar, name_en, delivery_label, delivery_hours, client_price::float8 AS client_price,
             investigator_price::float8 AS investigator_price, accept_minutes, active, sort, updated_at
           FROM service_levels ORDER BY sort`,
        ),
        query(
          `SELECT ${RULE_COLUMNS} FROM price_rules r
           LEFT JOIN form_clients c ON c.client_id = r.client_id LEFT JOIN users u ON u.user_id = r.updated_by
           WHERE r.active ORDER BY c.name NULLS FIRST, r.governorate NULLS FIRST, r.district NULLS FIRST, r.service_level`,
        ),
        query("SELECT client_id, name, client_type FROM form_clients ORDER BY name"),
      ]);
      return ok({ levels, rules, clients });
    }),
  );

  /** Adds a price, or replaces the one for the same type, client and area. */
  router.post(
    "/investigations/pricing/rules",
    withPermission(PERMISSIONS.PRICING_MANAGE, async (context, auth) => {
      const body = await readJson(context.req);
      const serviceLevel = requiredText(body.service_level, "service_level", 40);
      const [level] = await query("SELECT 1 FROM service_levels WHERE code = $1", [serviceLevel]);
      if (!level) throw ApiError.badRequest("Unknown investigation type", { field: "service_level" });
      const clientId = optionalText(body.client_id, 64);
      if (clientId) {
        const [client] = await query("SELECT 1 FROM form_clients WHERE client_id = $1", [clientId]);
        if (!client) throw ApiError.badRequest("Unknown client", { field: "client_id" });
      }
      // Snapped to the existing places, so one price never splits over two spellings.
      const snapped = await canonicalNames(
        {
          governorate: optionalText(body.governorate, 120),
          district: optionalText(body.district, 120),
          local_unit: null,
          main_village: null,
          sub_village: null,
        },
        { strictGovernorate: false },
      );
      const governorate = snapped.governorate;
      const district = snapped.district;
      if (district && !governorate) throw ApiError.badRequest("Choose the governorate of this district", { field: "governorate" });
      if (!clientId && !governorate) {
        throw ApiError.badRequest("Choose a client, an area or both (the type's own price covers everything else)");
      }
      const prices = [money(body, "client_price"), money(body, "investigator_price")];
      const keys = [governorate ? nameKey(governorate) : null, district ? nameKey(district) : null];
      // Same type, client and area: the new price replaces the old one (kept for history).
      await query(
        `UPDATE price_rules SET active = false, updated_by = $5, updated_at = now()
         WHERE active AND service_level = $1 AND COALESCE(client_id, '') = COALESCE($2, '')
           AND COALESCE(governorate_key, '') = COALESCE($3, '') AND COALESCE(district_key, '') = COALESCE($4, '')`,
        [serviceLevel, clientId, keys[0], keys[1], auth.user.user_id],
      );
      const [rule] = await query(
        `INSERT INTO price_rules (service_level, client_id, governorate, governorate_key, district, district_key,
           client_price, investigator_price, note, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING rule_id`,
        [serviceLevel, clientId, governorate, keys[0], district, keys[1], ...prices, optionalText(body.note, 300), auth.user.user_id],
      );
      await recordAudit({
        event: "pricing.updated",
        actorId: auth.user.user_id,
        success: true,
        context,
        metadata: { rule_id: rule?.rule_id, service_level: serviceLevel, client_id: clientId, governorate, district, prices },
      });
      return ok({ rule_id: rule?.rule_id });
    }),
  );

  router.delete(
    "/investigations/pricing/rules/:rule_id",
    withPermission(PERMISSIONS.PRICING_MANAGE, async (context, auth) => {
      const rows = await query(
        "UPDATE price_rules SET active = false, updated_by = $2, updated_at = now() WHERE rule_id = $1 AND active RETURNING rule_id",
        [context.params.rule_id, auth.user.user_id],
      );
      if (!rows.length) throw ApiError.notFound("Price not found");
      await recordAudit({
        event: "pricing.updated",
        actorId: auth.user.user_id,
        success: true,
        context,
        metadata: { rule_id: context.params.rule_id, removed: true },
      });
      return ok({ removed: true });
    }),
  );
}
