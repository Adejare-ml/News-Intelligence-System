/**
 * The companies a reader can follow by email (slug and name), read by
 * /api/follow, /api/follow-confirm and /api/preferences to validate a follow
 * and by /api/send-brief to name companies. Known companies with an entity
 * page only (isKnownCompany, never a person filed as a company), from
 * published data only.
 */
import { followableCompanies } from "../../../../lib/follow.ts";
import { siteEntities } from "../../../../lib/site-entities.ts";

export function GET() {
  return new Response(JSON.stringify({ companies: followableCompanies(siteEntities()) }), { headers: { "Content-Type": "application/json" } });
}
