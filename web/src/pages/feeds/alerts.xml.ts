/** /feeds/alerts.xml: the alerts inbox (alerts.json) as RSS, cleaned the same way. */
import * as data from "../../lib/data.ts";
import { href } from "../../lib/url.ts";
import { cleanAlerts } from "../../lib/alerts.ts";
import { rssFeed } from "../../lib/feeds.ts";

export function GET({ site }: { site?: URL }) {
  const abs = (path: string) => new URL(href(path), site).toString();
  const xml = rssFeed({
    title: "AURA alerts",
    link: abs(""),
    self: abs("feeds/alerts.xml"),
    description: "Stories AURA's risk model scored high or critical in the last few days. Scores are model estimates from the reporting, not findings.",
    items: cleanAlerts(data.alerts().alerts ?? []).map((a) => ({
      title: a.title,
      link: a.url,
      // Alerts carry a day, not a time; noon UTC keeps the day right in every zone readers use.
      date: a.date ? new Date(`${a.date}T12:00:00Z`) : null,
      description: `${a.level} risk (score ${a.score}) · ${a.source}`,
    })),
  });
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
}
