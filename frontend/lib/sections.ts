/** The seven shelf books, in shelf order. `slug` is the section's URL. */
export const SECTIONS = [
  { slug: "files", title: "Files", note: "Documents and uploads, kept in one place.", color: "#182a43", foil: "#c87046" },
  { slug: "pay-log", title: "Pay Log", note: "Payments in and out, logged as they happen.", color: "#c24d24", foil: "#efc16d" },
  { slug: "todos", title: "Todos", note: "What is next, and what is done.", color: "#afc400", foil: "#171a16" },
  { slug: "projects", title: "Projects", note: "Work in progress, from idea to shipped.", color: "#1537a1", foil: "#dbe8f1" },
  { slug: "notes", title: "Notes", note: "Thoughts worth writing down.", color: "#c83222", foil: "#efb0aa" },
  { slug: "bookmarks", title: "Bookmarks", note: "Links saved for later.", color: "#da3b2f", foil: "#ff8eab" },
  { slug: "vault", title: "My Vault", note: "Private things, kept locked away.", color: "#78a7bd", foil: "#e4e7e5" },
] as const;

export type Section = (typeof SECTIONS)[number];

export function findSection(slug: string): Section | undefined {
  return SECTIONS.find((section) => section.slug === slug);
}

export function isSectionRoute(route: unknown): route is string {
  return typeof route === "string" && SECTIONS.some((section) => `/${section.slug}` === route);
}
