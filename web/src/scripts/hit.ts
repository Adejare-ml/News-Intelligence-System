/**
 * One cookieless count per page view, sent to /api/hit (see
 * functions/api/hit.ts). Nothing is stored in the browser and nothing
 * identifies the reader.
 */
import { pageHit, trackingAllowed } from "../lib/hit-beacon.ts";

const { body, cleanUrl } = pageHit(location);
if (trackingAllowed(navigator as Navigator & { globalPrivacyControl?: boolean }, import.meta.env.BASE_URL)) {
  navigator.sendBeacon?.("/api/hit", JSON.stringify(body));
}
// Remove the Morning Brief tag whether or not this view was counted.
if (cleanUrl !== null) history.replaceState(history.state, "", cleanUrl);
