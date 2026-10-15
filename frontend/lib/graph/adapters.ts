import type { GraphData, GraphGroupStyle, GraphLink, GraphNode } from "./types";
import { UNRESOLVED_GROUP } from "./theme";

export interface MarkdownNote {
  /** Vault-relative path, e.g. "Infra/Caching.md". */
  path: string;
  content: string;
  title?: string;
}

export interface MarkdownOptions {
  /** Treat ![[embeds]] as links (default) or skip them. */
  embeds?: "link" | "ignore";
  /** Keep links to non-markdown files (images, PDFs) as "attachment" nodes. Off by default. */
  attachments?: boolean;
  /** How a note's group is picked. Default: top-level folder, else the first #tag. */
  groupBy?: "folder" | "tag" | ((note: MarkdownNote, tags: string[]) => string | undefined);
  /**
   * Also resolve [[Alias]] to the note that lists it in frontmatter `aliases`. Off by default, like
   * Obsidian, which shows a bare [[Alias]] as unresolved (its autocomplete writes [[Note|Alias]]).
   */
  resolveAliases?: boolean;
  /**
   * Vault-relative paths of the vault's attachment files ("Assets/diagram.png"). With `attachments`,
   * `![[diagram.png]]` then resolves to that file wherever it lives, as in Obsidian, so two spellings
   * of one file make one node. Without it, attachments are keyed by the path as written.
   */
  attachmentPaths?: readonly string[];
}

interface ParsedNote {
  id: string;
  dir: string;
  label: string;
  tags: string[];
  aliases: string[];
  group?: string;
  targets: { text: string; embed: boolean; relative: boolean }[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const CODE = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|<!--[\s\S]*?-->|%%[\s\S]*?%%/g;
const WIKILINK = /(!?)\[\[([^\]\n]+?)\]\]/g;
const MD_LINK = /(!?)\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+["'][^"'\n]*["'])?\s*\)/g;
const TAG = /(?:^|[\s(,])#([A-Za-z0-9_\-/À-￿]+)/g;
// The (target) half of [text](target), so "#anchor" links aren't read as tags.
const MD_LINK_TARGET = /\]\([^)\n]*\)/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// Files Obsidian opens as attachments; anything else ("Next.js", "Web 3.0") is a note name.
const ATTACHMENT = /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico|tiff?|heic|pdf|mp3|wav|m4a|ogg|oga|flac|3gp|mp4|webm|ogv|mov|mkv|canvas|base|excalidraw)$/i;

/** Whether Obsidian treats `path` as an attachment (image, audio, video, PDF, canvas) rather than a note. */
export function isAttachmentPath(path: string): boolean {
  return ATTACHMENT.test(path);
}

function stripExtension(path: string): string {
  return path.replace(/\.md$/i, "");
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** Joins and resolves "." and ".." segments, posix style. */
function joinPath(dir: string, relative: string): string {
  const parts = relative.startsWith("/") ? [] : dir.split("/").filter(Boolean);
  for (const part of relative.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function yamlList(frontmatter: string, key: string): string[] {
  const inline = frontmatter.match(new RegExp(`^${key}:[ \\t]*(\\S.*)$`, "m"));
  if (inline) {
    return inline[1].replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean);
  }
  const block = frontmatter.match(new RegExp(`^${key}:[ \\t]*\\r?\\n((?:[ \\t]*-[ \\t]*.+\\r?\\n?)+)`, "m"));
  if (!block) return [];
  return block[1].split(/\r?\n/).map((line) => unquote(line.replace(/^[ \t]*-[ \t]*/, ""))).filter(Boolean);
}

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "").replace(/^#/, "").trim();
}

function parseNote(note: MarkdownNote, options: MarkdownOptions): ParsedNote {
  const path = note.path.replace(/\\/g, "/").replace(/^\.?\//, "");
  const id = stripExtension(path);
  const match = note.content.match(FRONTMATTER);
  const frontmatter = match?.[1] ?? "";
  const body = (match ? note.content.slice(match[0].length) : note.content).replace(CODE, " ");

  const tags = new Set(yamlList(frontmatter, "tags"));
  for (const [, tag] of body.replace(MD_LINK_TARGET, "]").matchAll(TAG)) if (!/^[0-9/]+$/.test(tag)) tags.add(tag);
  const tagList = [...tags];

  const targets: ParsedNote["targets"] = [];
  // Property links (up: "[[MOC]]", related: ["[[CDN]]"]) count too, as in Obsidian 1.4+.
  for (const source of [frontmatter, body]) {
    for (const [, bang, inner] of source.matchAll(WIKILINK)) {
      if (bang && options.embeds === "ignore") continue;
      const text = inner.replace(/\\\|/g, "|").split("|")[0].split("#")[0].trim();
      if (text) targets.push({ text, embed: !!bang, relative: false });
    }
  }
  for (const [, bang, raw] of body.matchAll(MD_LINK)) {
    if (bang && options.embeds === "ignore") continue;
    let href = raw.replace(/^<|>$/g, "");
    if (SCHEME.test(href) || href.startsWith("#")) continue;
    href = href.split("#")[0].split("?")[0];
    try { href = decodeURIComponent(href); } catch { /* keep it as written */ }
    if (href) targets.push({ text: href, embed: !!bang, relative: true });
  }

  const title = note.title ?? unquote(frontmatter.match(/^title:[ \t]*(.+)$/m)?.[1] ?? "");
  const folder = path.includes("/") ? path.slice(0, path.indexOf("/")) : undefined;
  const groupBy = options.groupBy ?? "folder";
  const group =
    typeof groupBy === "function" ? groupBy(note, tagList)
    : groupBy === "tag" ? tagList[0]?.split("/")[0] ?? folder
    : folder ?? tagList[0]?.split("/")[0];

  return {
    id,
    dir: dirname(path),
    label: title || basename(id),
    tags: tagList,
    aliases: yamlList(frontmatter, "aliases"),
    group,
    targets,
  };
}

/**
 * Finds the file a link points at the way Obsidian does. Markdown links may be relative
 * ("../Infra/Caching.md"), vault-absolute ("Infra/Caching.md") or shortest-path ("Caching.md"),
 * tried in that order; a bare name matches anywhere, same folder first, then the shortest path.
 * `byPath` and `byName` are keyed by lowercased path (as `key` leaves it) and file name.
 */
function lookup(
  text: string,
  dir: string,
  relative: boolean,
  byPath: ReadonlyMap<string, string>,
  byName: ReadonlyMap<string, readonly string[]>,
  key: (path: string) => string,
): string | undefined {
  if (relative) {
    const exact = byPath.get(key(joinPath(dir, text)).toLowerCase());
    if (exact || /^\.\.?\//.test(text)) return exact;
  }
  const wanted = key(text.replace(/^\//, "")).toLowerCase();
  const exact = byPath.get(wanted);
  if (exact) return exact;
  if (wanted.includes("/")) {
    for (const [path, id] of byPath) if (path.endsWith(`/${wanted}`)) return id;
    return undefined;
  }
  const candidates = byName.get(wanted);
  if (!candidates?.length) return undefined;
  return candidates.find((id) => dirname(id) === dir) ?? [...candidates].sort((a, b) => a.length - b.length)[0];
}

/**
 * Builds a graph from markdown notes the way Obsidian does: [[Note]], [[Note|alias]], [[Note#heading]],
 * ![[embeds]], links in frontmatter properties, and [text](Note.md) links (relative, vault-absolute or
 * shortest-path). Unmatched targets become unresolved nodes.
 */
export function fromMarkdownNotes(notes: readonly MarkdownNote[], options: MarkdownOptions = {}): GraphData {
  const parsed = notes.map((note) => parseNote(note, options));
  const byPath = new Map<string, string>();
  const byName = new Map<string, string[]>();
  const byAlias = new Map<string, string>();
  for (const note of parsed) {
    const lower = note.id.toLowerCase();
    byPath.set(lower, note.id);
    const name = basename(lower);
    byName.set(name, [...(byName.get(name) ?? []), note.id]);
    for (const alias of note.aliases) if (!byAlias.has(alias.toLowerCase())) byAlias.set(alias.toLowerCase(), note.id);
  }

  const findNote = (text: string, from: ParsedNote, relative: boolean): string | undefined => {
    const found = lookup(text, from.dir, relative, byPath, byName, stripExtension);
    if (found || !options.resolveAliases) return found;
    const alias = stripExtension(text.replace(/^\//, "")).toLowerCase();
    return alias.includes("/") ? undefined : byAlias.get(alias);
  };

  const filesByPath = new Map<string, string>();
  const filesByName = new Map<string, string[]>();
  for (const raw of options.attachments ? options.attachmentPaths ?? [] : []) {
    const path = raw.replace(/\\/g, "/").replace(/^\.?\//, "");
    const lower = path.toLowerCase();
    if (filesByPath.has(lower)) continue;
    filesByPath.set(lower, path);
    const name = basename(lower);
    filesByName.set(name, [...(filesByName.get(name) ?? []), path]);
  }
  const asIs = (path: string) => path;

  const nodes: GraphNode[] = parsed.map((note, i) => ({
    id: note.id,
    label: note.label,
    group: note.group,
    tags: note.tags,
    meta: { path: notes[i].path },
  }));
  const extra = new Map<string, GraphNode>();
  const weights = new Map<string, GraphLink>();

  for (const note of parsed) {
    for (const target of note.targets) {
      let id = findNote(target.text, note, target.relative);
      if (!id) {
        const written = target.text.replace(/^\//, "");
        if (ATTACHMENT.test(written)) {
          if (!options.attachments) continue;
          const file = lookup(target.text, note.dir, target.relative, filesByPath, filesByName, asIs);
          id = file ?? (target.relative ? joinPath(note.dir, target.text) : written);
          if (!extra.has(id)) extra.set(id, { id, label: basename(id), group: "attachment", ...(file && { meta: { path: file } }) });
        } else {
          // Unresolved notes are keyed by what was written, unless the link is explicitly relative.
          id = stripExtension(target.relative && /^\.\.?\//.test(target.text) ? joinPath(note.dir, target.text) : written);
          const key = `\u0000${id.toLowerCase()}`;
          const known = extra.get(key);
          if (known) id = known.id;
          else extra.set(key, { id, label: basename(id), group: UNRESOLVED_GROUP, unresolved: true });
        }
      }
      if (id === note.id) continue;
      const key = `${note.id}\u0000${id}`;
      const link = weights.get(key);
      if (link) link.weight = (link.weight ?? 1) + 1;
      else weights.set(key, { source: note.id, target: id, weight: 1 });
    }
  }

  return { nodes: [...nodes, ...extra.values()], links: [...weights.values()] };
}

function splitRow(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let field = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field.trim() === "") { quoted = true; field = ""; }
    else if (c === delimiter) { fields.push(field.trim()); field = ""; }
    else field += c;
  }
  fields.push(field.trim());
  return fields;
}

/**
 * Parses an edge list: one `source,target[,weight]` per line. Comma, semicolon and tab separators,
 * quoted fields, an optional header row (source/target/weight, from/to) and # comments all work.
 */
export function fromEdgeList(text: string): GraphData {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !/^\s*(#|\/\/)/.test(line));
  if (lines.length === 0) return { nodes: [], links: [] };
  const sample = lines[0];
  const delimiter = sample.includes("\t") ? "\t" : sample.includes(";") && !sample.includes(",") ? ";" : ",";

  let columns = { source: 0, target: 1, weight: 2 };
  const head = splitRow(sample, delimiter).map((cell) => cell.toLowerCase());
  const find = (...names: string[]) => head.findIndex((cell) => names.includes(cell));
  if (find("source", "from", "src") >= 0 && find("target", "to", "dst") >= 0) {
    columns = { source: find("source", "from", "src"), target: find("target", "to", "dst"), weight: find("weight", "value") };
    lines.shift();
  }

  const nodes = new Map<string, GraphNode>();
  const links: GraphLink[] = [];
  for (const line of lines) {
    const cells = splitRow(line, delimiter);
    const source = cells[columns.source], target = cells[columns.target];
    if (!source || !target) continue;
    for (const id of [source, target]) if (!nodes.has(id)) nodes.set(id, { id, label: id });
    const weight = Number(cells[columns.weight]);
    links.push(Number.isFinite(weight) && weight > 0 ? { source, target, weight } : { source, target });
  }
  return { nodes: [...nodes.values()], links };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKey(value: unknown): value is string | number {
  return (typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isFinite(value));
}

/** `null` and `""` read as "not set". */
function optional(value: unknown): unknown {
  return value === null || value === "" ? undefined : value;
}

/** A link end: an id, or a d3-style node object `{ id }`. */
function endpoint(value: unknown): string | undefined {
  const id = isRecord(value) ? value.id : value;
  return isKey(id) ? String(id) : undefined;
}

/** Checks untrusted JSON against the GraphData contract; throws an Error naming the first problem. */
export function parseGraphData(value: unknown, origin = "graph data"): GraphData {
  const fail = (problem: string): never => { throw new Error(`Invalid ${origin}: ${problem}`); };
  if (!isRecord(value)) return fail('expected a JSON object with "nodes" and "links" arrays');
  const rawNodes = value.nodes;
  const rawLinks = value.links ?? value.edges;
  if (!Array.isArray(rawNodes)) return fail('"nodes" must be an array');
  if (!Array.isArray(rawLinks)) return fail('"links" (or "edges") must be an array');

  const nodes = rawNodes.map((raw, i): GraphNode => {
    if (!isRecord(raw)) return fail(`nodes[${i}] must be an object`);
    if (!isKey(raw.id)) return fail(`nodes[${i}].id must be a non-empty string or a number`);
    // null and "" mean "not set", as many exporters write them.
    const label = optional(raw.label ?? raw.title ?? raw.name);
    const group = optional(raw.group), tags = optional(raw.tags), unresolved = optional(raw.unresolved), meta = optional(raw.meta);
    if (label !== undefined && typeof label !== "string") return fail(`nodes[${i}].label must be a string`);
    if (group !== undefined && !isKey(group)) return fail(`nodes[${i}].group must be a string or a number`);
    if (tags !== undefined && !(Array.isArray(tags) && tags.every((t) => typeof t === "string"))) {
      return fail(`nodes[${i}].tags must be an array of strings`);
    }
    if (unresolved !== undefined && typeof unresolved !== "boolean") return fail(`nodes[${i}].unresolved must be a boolean`);
    if (meta !== undefined && !isRecord(meta)) return fail(`nodes[${i}].meta must be an object`);
    const id = String(raw.id);
    return {
      id,
      label: label || id,
      ...(group !== undefined && { group: String(group) }),
      ...(tags !== undefined && { tags: tags as string[] }),
      ...(unresolved !== undefined && { unresolved }),
      ...(meta !== undefined && { meta }),
    };
  });

  const links = rawLinks.map((raw, i): GraphLink => {
    if (!isRecord(raw)) return fail(`links[${i}] must be an object`);
    const source = endpoint(raw.source), target = endpoint(raw.target), weight = optional(raw.weight);
    if (source === undefined) return fail(`links[${i}].source must be a node id`);
    if (target === undefined) return fail(`links[${i}].target must be a node id`);
    if (weight !== undefined && !(typeof weight === "number" && Number.isFinite(weight) && weight >= 0)) {
      return fail(`links[${i}].weight must be a non-negative number`);
    }
    const link: GraphLink = { source, target };
    if (typeof weight === "number") link.weight = weight;
    return link;
  });

  let groups: Record<string, GraphGroupStyle> | undefined;
  if (optional(value.groups) !== undefined) {
    if (!isRecord(value.groups)) return fail('"groups" must be an object of { label?, color? }');
    groups = Object.create(null) as Record<string, GraphGroupStyle>;
    for (const [key, style] of Object.entries(value.groups)) {
      if (!isRecord(style)) return fail(`groups.${key} must be an object`);
      const label = optional(style.label), color = optional(style.color);
      if (label !== undefined && typeof label !== "string") return fail(`groups.${key}.label must be a string`);
      if (color !== undefined && typeof color !== "string") return fail(`groups.${key}.color must be a string`);
      groups[key] = { label, color };
    }
  }
  return groups ? { nodes, links, groups } : { nodes, links };
}

/** Loads GraphData JSON from `url` (optionally with a bearer token) and validates it. */
export async function fetchGraph(url: string, token?: string, init: RequestInit = {}): Promise<GraphData> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(`Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!res.ok) throw new Error(`Could not load the graph from ${url}: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch (error) {
    // Aborting while the body streams in rejects here too; that is not a JSON problem.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(`The graph at ${url} is not valid JSON`);
  }
  return parseGraphData(body, `graph from ${url}`);
}
