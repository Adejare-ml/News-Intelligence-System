/**
 * Follow, in this browser only.
 *  - Company pages: a Follow button that saves the company to localStorage.
 *    Never on a person's page, which is one holder at one company: a follow
 *    matches news by name, so it would show another person of that name.
 *  - Home page: a "Following" panel with each followed company's latest
 *    mention, from /following.json (same origin, so the CSP's connect-src
 *    'self' allows it). That file is built through the unpublish-aware
 *    loaders, so it never names what the owner unpublished.
 *  - Every page: a dot on the alerts bell while an unread alert names a
 *    followed company.
 * Everything starts hidden in the HTML, so without JavaScript (or without
 * storage) none of it shows. Nothing leaves the browser.
 */
import { FOLLOW_KEY, parseFollows, toggleFollow, latestMention, hasNewFollowedAlert, type Follow, type FollowAlert, type FollowingFeed } from "../lib/follow.ts";
import { ALERTS_READ_KEY } from "../lib/alerts.ts";

function load(): Follow[] {
  try {
    return parseFollows(localStorage.getItem(FOLLOW_KEY));
  } catch {
    return [];
  }
}

/** False when storage is blocked (private mode, site data off): the button then stays hidden. */
function save(list: Follow[]): boolean {
  try {
    localStorage.setItem(FOLLOW_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

function readAlerts(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(ALERTS_READ_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

const requests = new Map<string, Promise<unknown>>();
// One request per file per page, shared by the panel and the bell dot; a failed fetch shows nothing.
async function getJson<T>(url: string | undefined, fallback: T): Promise<T> {
  if (!url) return fallback;
  if (!requests.has(url)) requests.set(url, fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return ((await requests.get(url)) ?? fallback) as T;
}

/* ---------- Follow button (entity pages) ---------- */
const button = document.querySelector<HTMLButtonElement>("[data-follow]");
const wrap = document.querySelector<HTMLElement>("[data-follow-wrap]");
if (button && wrap && save(load())) {
  const item: Follow = { slug: button.dataset.slug!, name: button.dataset.name! };
  // A toggle button keeps one label; aria-pressed (styled in the page) carries the state,
  // so screen readers do not announce it twice ("Following, pressed").
  const sync = () => button.setAttribute("aria-pressed", String(load().some((f) => f.slug === item.slug)));
  button.addEventListener("click", () => {
    save(toggleFollow(load(), item));
    sync();
    void updateDot();
  });
  sync();
  wrap.hidden = false;
}

/* ---------- Following panel (home page) ---------- */
const panel = document.querySelector<HTMLElement>("[data-following]");
const follows = load();
if (panel && follows.length) {
  const list = panel.querySelector<HTMLElement>("[data-following-list]")!;
  void Promise.all([
    getJson<Partial<FollowingFeed>>(panel.dataset.latest, {}),
    getJson<{ alerts?: FollowAlert[] }>(panel.dataset.alerts, {}),
  ]).then(([{ articles }, alerts]) => {
    list.replaceChildren(
      ...follows.map((f) => {
        const li = document.createElement("li");
        const name = document.createElement("a");
        name.className = "f-name";
        name.href = `${panel.dataset.entity}${f.slug}/`;
        name.textContent = f.name;
        const latest = document.createElement("p");
        latest.className = "meta f-latest";
        const m = latestMention(f.name, Array.isArray(articles) ? articles : [], alerts.alerts ?? []);
        if (m && m.url) {
          const link = document.createElement("a");
          link.href = m.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = m.title;
          latest.append("Latest: ", link, ` · ${[m.source, m.date].filter(Boolean).join(" · ")}`);
        } else {
          latest.textContent = "No mention in the latest edition or alerts.";
        }
        li.append(name, latest);
        return li;
      }),
    );
    panel.hidden = false;
  });
}

/* ---------- Dot on the alerts bell (every page) ---------- */
const dot = document.querySelector<HTMLElement>("[data-follow-dot]");
// The bell's aria-label belongs to the inbox script (unread count), so the dot's meaning
// reaches screen readers through this note, which the bell names in aria-describedby.
const note = document.querySelector<HTMLElement>("[data-follow-note]");
function showDot(on: boolean) {
  dot!.hidden = !on;
  if (note) note.textContent = on ? "Includes a new alert about a company you follow" : "";
}
async function updateDot() {
  if (!dot) return;
  const current = load();
  if (!current.length) {
    showDot(false);
    return;
  }
  const alerts = await getJson<{ alerts?: FollowAlert[] }>(dot.dataset.alerts, {});
  showDot(hasNewFollowedAlert(alerts.alerts ?? [], current, readAlerts()));
}
void updateDot();
// Reading an alert in the inbox can clear the dot; the inbox saves first, so check after it.
document.addEventListener("click", (e) => {
  if ((e.target as Element).closest("[data-alert], [data-inbox-markall]")) window.setTimeout(updateDot, 0);
});
