import type { AuthContext } from "../IdentityAcess_Services/MIddlewares/auth.middleware.ts";
import { hasPermission, PERMISSIONS } from "../IdentityAcess_Services/Services/rbac.service.ts";

/**
 * Money is head office's: what clients pay, what investigators earn, revenue and profit.
 * Administrators send and review investigations without seeing any of it; an investigator
 * sees only their own pay (in the app).
 */
export const seesMoney = (auth: AuthContext) =>
  hasPermission(auth.access, PERMISSIONS.HEADOFFICE_MANAGE) || hasPermission(auth.access, PERMISSIONS.PRICING_MANAGE);

const MONEY_KEY = /price|earn|revenue|payout|profit|pay$|_pay|amount|margin/i;

/** The same data without any money field (deep). */
export function withoutMoney<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => withoutMoney(item)) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !MONEY_KEY.test(key))
        .map(([key, item]) => [key, withoutMoney(item)]),
    ) as T;
  }
  return value;
}
