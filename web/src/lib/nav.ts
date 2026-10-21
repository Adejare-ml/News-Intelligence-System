/**
 * Site sections, in one place, so the header, the mobile tab bar and the
 * footer can never link to a page that has not shipped yet.
 */
export interface Section {
  path: string;
  label: string;
  short: string;
  icon: "home" | "newspaper" | "shield" | "layers" | "cpu";
}

export const SECTIONS: Section[] = [
  { path: "", label: "Today", short: "Today", icon: "home" },
  { path: "brief/", label: "Brief", short: "Brief", icon: "newspaper" },
  { path: "register/", label: "Register", short: "Register", icon: "shield" },
  { path: "news/", label: "News", short: "News", icon: "layers" },
  { path: "how-it-works/", label: "How it works", short: "How", icon: "cpu" },
];

export const hasSection = (path: string) => SECTIONS.some((s) => s.path === path);
