#!/usr/bin/env node
/**
 * Static checks for a Xian project (Handlebars templates in `.xian` files). No dependencies required.
 *
 *   node scripts/check-views.mjs [projectRoot]
 *
 * It finds the mistakes that otherwise only blow up at request time:
 *   - {{> partial}} calls with no matching file in views/partials (inline partials are understood)
 *   - helpers, block helpers and subexpressions that are neither Handlebars built-ins nor files in views/helpers
 *   - layouts without {{{body}}} or without the head partial
 *   - res.render("x") targets with no views/pages/x.xian, layout names with no views/layouts/<name>.xian
 *   - res.render() calls that do not pass pageTitle (head.xian prints it; development strict mode throws without it)
 *   - unbalanced {{#block}}...{{/block}} (and, when `handlebars` is installed, real syntax errors)
 * Exit code is 1 when any ERROR is found, 0 otherwise (warnings never fail the run).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const root = path.resolve(process.argv[2] ?? process.cwd());
const dirs = {
  pages: path.join(root, "views/pages"),
  layouts: path.join(root, "views/layouts"),
  partials: path.join(root, "views/partials"),
  helpers: path.join(root, "views/helpers"),
};

if (!fs.existsSync(path.join(root, "views"))) {
  console.error(`No views/ folder under ${root}. Run this from the project root or pass the root as an argument.`);
  process.exit(2);
}

const rel = (p) => path.relative(root, p).split(path.sep).join("/");
const findings = [];
const add = (level, file, line, message) => findings.push({ level, file: rel(file), line, message });
const lineOf = (src, index) => src.slice(0, index).split("\n").length;

function walk(dir, accept, skip = () => false) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== ".git" && !skip(full)) out.push(...walk(full, accept, skip));
    } else if (accept(entry.name)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------- what exists
const isXian = (name) => name.endsWith(".xian");
const pageFiles = walk(dirs.pages, isXian);
const layoutFiles = walk(dirs.layouts, isXian);
const partialFiles = walk(dirs.partials, isXian);
const helperFiles = fs.existsSync(dirs.helpers)
  ? fs.readdirSync(dirs.helpers, { withFileTypes: true }).filter((e) => e.isFile() && /\.(js|mjs)$/.test(e.name)).map((e) => path.join(dirs.helpers, e.name))
  : [];

// same naming rules as src/xian/partials.js and src/xian/helpers.js
const partialNames = new Set(partialFiles.map((f) => path.relative(dirs.partials, f).replace(/\.xian$/, "").split(path.sep).join("/")));
const layoutNames = new Set(layoutFiles.map((f) => path.basename(f, ".xian")));
const helperNames = new Set(helperFiles.map((f) => path.basename(f).replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_")));
const BUILTIN_HELPERS = new Set(["if", "unless", "each", "with", "lookup", "log", "blockHelperMissing", "helperMissing"]);
const isKnownHelper = (name) => BUILTIN_HELPERS.has(name) || helperNames.has(name);

// optional: the real Handlebars parser, for true syntax errors with line numbers
let handlebars = null;
try {
  const resolved = createRequire(path.join(root, "package.json")).resolve("handlebars");
  handlebars = (await import(pathToFileURL(resolved).href)).default;
} catch {
  /* not installed: fall back to the built-in block-balance check */
}

// ---------------------------------------------------------------- template scanning
const blank = (s) => s.replace(/[^\n]/g, " ");
const stripComments = (src) => src.replace(/\{\{!--[\s\S]*?--\}\}/g, blank).replace(/\{\{![\s\S]*?\}\}/g, blank);
const MUSTACHE = /(\\+)?\{\{(\{)?(~)?([\s\S]*?)(~)?(\})?\}\}/g;
const NAME_TOKEN = /^("[^"]+"|'[^']+'|[^\s)~]+)/;
const unquote = (s) => s.replace(/^["']|["']$/g, "");

function scanTemplate(file, kind) {
  const original = fs.readFileSync(file, "utf8");
  const src = stripComments(original);

  if (handlebars) {
    try {
      handlebars.parse(original);
    } catch (error) {
      const lines = String(error.message).split("\n");
      const summary = lines.length > 1 ? `${lines[0]} ${lines.at(-1)}` : lines[0];
      add("error", file, Number(/line (\d+)/i.exec(error.message)?.[1] ?? 1), `Handlebars syntax error: ${summary}`);
      return; // the regex pass below would only repeat the same problem
    }
  }

  const inlinePartials = new Set([...src.matchAll(/\{\{~?#\*inline\s+["']([^"']+)["']/g)].map((m) => m[1]));
  const stack = [];

  for (const m of src.matchAll(MUSTACHE)) {
    if (m[1] && m[1].length % 2 === 1) continue; // \{{escaped}}
    const line = lineOf(src, m.index + (m[1]?.length ?? 0));
    const inner = m[4].trim();
    if (!inner) continue;
    const isTriple = Boolean(m[2]);
    const noStrings = inner.replace(/"[^"]*"|'[^']*'/g, '""');

    // ---- closing tag
    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim().split(/\s+/)[0];
      const top = stack.pop();
      if (!handlebars) {
        if (!top) add("error", file, line, `{{/${name}}} closes a block that was never opened`);
        else if (top.name !== name) add("error", file, line, `{{/${name}}} closes {{#${top.name}}} opened on line ${top.line}`);
      }
      continue;
    }

    // ---- partial call / partial block
    const isPartialBlock = inner.startsWith("#>");
    if (inner.startsWith(">") || isPartialBlock) {
      const rest = inner.slice(isPartialBlock ? 2 : 1).trim();
      const token = NAME_TOKEN.exec(rest)?.[1] ?? "";
      const name = unquote(token);
      if (isPartialBlock) stack.push({ name, line });
      if (name && !name.startsWith("(") && !name.startsWith("@") && !partialNames.has(name) && !inlinePartials.has(name)) {
        add("error", file, line, `partial "${name}" not found (expected views/partials/${name}.xian)`);
      }
      checkSubexpressions(file, line, noStrings);
      continue;
    }

    // ---- decorators and block opens
    if (inner.startsWith("#")) {
      const decorator = inner.startsWith("#*");
      const name = inner.slice(decorator ? 2 : 1).trim().split(/[\s~]/)[0];
      stack.push({ name, line });
      if (!decorator && !isKnownHelper(name)) {
        add("error", file, line, `block helper "${name}" is not a Handlebars built-in and there is no views/helpers/${name}.js`);
      }
      checkSubexpressions(file, line, noStrings);
      continue;
    }

    // ---- else / inverse
    if (inner === "else" || inner === "^" || inner.startsWith("else ")) {
      checkSubexpressions(file, line, noStrings);
      continue;
    }

    // ---- plain expression: {{x}} {{{x}}} {{&x}} {{helper arg}}
    const expr = inner.startsWith("&") ? inner.slice(1).trim() : inner;
    const first = expr.split(/\s+/)[0];
    const hasArgs = noStrings.trim().length > first.length;
    if (/^[A-Za-z_][\w-]*$/.test(first) && hasArgs && !isKnownHelper(first)) {
      add("error", file, line, `helper "${first}" is not a Handlebars built-in and there is no views/helpers/${first}.js`);
    }
    if (isTriple && first !== "body") {
      add("warn", file, line, `{{{${first}}}} prints raw HTML (no escaping): only use it for trusted markup, never for user input`);
    }
    checkSubexpressions(file, line, noStrings);
  }

  if (!handlebars) {
    for (const open of stack) add("error", file, open.line, `{{#${open.name}}} is never closed`);
  }

  if (kind === "layout") {
    if (!/\{\{\{\s*body\s*\}\}\}/.test(src)) add("error", file, 1, "layout has no {{{body}}}: the page content would never be rendered");
    if (!/\{\{~?>\s*head\b/.test(src)) add("warn", file, 1, "layout does not include {{>head}}: Tailwind, Bootstrap Icons and SweetAlert2 will not load");
  }
  if (kind === "page" && /<\/?(?:html|head|body)\b/i.test(src)) {
    add("warn", file, lineOf(src, src.search(/<\/?(?:html|head|body)\b/i)), "page contains <html>/<head>/<body>: pages are injected into a layout (fine only when always rendered with layout: false)");
  }
}

function checkSubexpressions(file, line, text) {
  for (const sub of text.matchAll(/\(\s*([A-Za-z_][\w-]*)/g)) {
    if (!isKnownHelper(sub[1])) add("error", file, line, `subexpression helper "${sub[1]}" is not a Handlebars built-in and there is no views/helpers/${sub[1]}.js`);
  }
}

for (const f of pageFiles) scanTemplate(f, "page");
for (const f of layoutFiles) scanTemplate(f, "layout");
for (const f of partialFiles) scanTemplate(f, "partial");

// ---------------------------------------------------------------- helper files
for (const file of helperFiles) {
  const name = path.basename(file).replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const src = fs.readFileSync(file, "utf8");
  const exported = /export\s+default\b/.test(src) || new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b|export\\s+(?:const|let|var)\\s+${name}\\b`).test(src);
  if (!exported) add("error", file, 1, `helper file has no default export (or named export "${name}"): the engine throws at startup`);
}

// ---------------------------------------------------------------- res.render() call sites
const codeFiles = ["app", "src", "routes"].flatMap((d) => walk(path.join(root, d), (n) => /\.(js|mjs)$/.test(n), (full) => rel(full) === "src/xian"));
// blank out comments (keeping newlines) so commented-out res.render() calls are not reported; a "//" only starts a
// comment at the start of a line or after whitespace, which keeps "http://..." strings intact
const stripJsComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|\s)\/\/.*$/gm, (m, lead) => lead + blank(m.slice(lead.length)));
const sources = new Map(codeFiles.map((f) => [f, stripJsComments(fs.readFileSync(f, "utf8"))]));
const titleSetGlobally = [...sources.values()].some((s) => /\b(?:res|app)\.locals\.pageTitle\s*=/.test(s));

function matchingBrace(text, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return text.length;
}

for (const [file, text] of sources) {
  for (const m of text.matchAll(/\bres\.render\(\s*(["'`])([^"'`]+)\1\s*(,|\))?/g)) {
    const view = m[2];
    if (view.includes("${")) continue;
    const line = lineOf(text, m.index);
    if (!fs.existsSync(path.join(dirs.pages, `${view}.xian`))) {
      add("error", file, line, `res.render("${view}") has no page: expected views/pages/${view}.xian`);
      continue;
    }
    let options = "";
    let dynamicOptions = false;
    if (m[3] === ",") {
      const after = text.slice(m.index + m[0].length).trimStart();
      if (after.startsWith("{")) {
        const start = text.indexOf("{", m.index + m[0].length);
        options = text.slice(start, matchingBrace(text, start) + 1);
      } else dynamicOptions = true;
    }
    const layout = /\blayout\s*:\s*(false|(["'])([\w-]+)\2)/.exec(options);
    if (layout?.[3] && !layoutNames.has(layout[3])) {
      add("error", file, line, `res.render("${view}") uses layout "${layout[3]}" but views/layouts/${layout[3]}.xian does not exist`);
    }
    if (layout?.[1] === "false" || titleSetGlobally) continue;
    if (dynamicOptions) {
      add("warn", file, line, `res.render("${view}", <variable>): cannot see inside the data object, make sure it includes pageTitle`);
    } else if (!/\bpageTitle\b/.test(options)) {
      add("error", file, line, `res.render("${view}") does not pass pageTitle: head.xian prints it and development strict mode throws without it`);
    }
  }
}

// ---------------------------------------------------------------- report
const order = { error: 0, warn: 1 };
findings.sort((a, b) => order[a.level] - order[b.level] || a.file.localeCompare(b.file) || a.line - b.line);
const errors = findings.filter((f) => f.level === "error").length;
const warnings = findings.length - errors;

console.log(
  `Xian view check: ${pageFiles.length} pages, ${layoutFiles.length} layouts, ${partialFiles.length} partials, ${helperFiles.length} helpers, ${sources.size} code files scanned` +
    (handlebars ? " (Handlebars parser: on)" : " (Handlebars parser: off, install deps for syntax errors)"),
);
for (const f of findings) console.log(`${f.level === "error" ? "ERROR" : "warn "}  ${f.file}:${f.line}  ${f.message}`);
console.log(errors || warnings ? `\n${errors} error(s), ${warnings} warning(s)` : "\nAll good.");
process.exit(errors ? 1 : 0);
