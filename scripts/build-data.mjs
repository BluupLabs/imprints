// scripts/build-data.mjs
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.cwd();

const RESOURCES_DIR = path.join(ROOT, "resources");
const BASE_DIR = path.join(RESOURCES_DIR, "base");
const DIST_DIR = path.join(ROOT, "dist");
const DIST_IMAGES_DIR = path.join(DIST_DIR, "images");

// New: separate bases
const AMIIBO_DIR = path.join(BASE_DIR, "amiibo");
const SKYLANDERS_DIR = path.join(BASE_DIR, "skylanders");

const AMIIBO_BASE_PATH = path.join(AMIIBO_DIR, "tagBase.json");
const SKYLANDERS_BASE_PATH = path.join(SKYLANDERS_DIR, "tagBase.json");

// Existing patches + images
const PATCHES_DIR = path.join(RESOURCES_DIR, "patches");
const BASE_IMAGES_DIR = path.join(RESOURCES_DIR, "images");

function sha1Hex(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

function stableJsonStringify(obj) {
  // Deterministic JSON so SHA doesn't change due to key ordering / formatting.
  const seen = new WeakSet();

  const sorter = (value) => {
    if (value === null) return null;
    if (typeof value !== "object") return value;

    if (seen.has(value)) {
      throw new Error("Cannot stringify circular structure");
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map(sorter);
    }

    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = sorter(value[k]);
    }
    return out;
  };

  return JSON.stringify(sorter(obj));
}

function isoTimestampWithMillis() {
  return new Date().toISOString();
}

/**
 * Normalize `entry.image` into a dist-relative path under `images/…`
 * - If it already starts with `images/`, preserve subfolders (posix)
 * - Otherwise fall back to `images/<basename>` (backwards compatible with Amiibo)
 */
function normalizeImagePath(entry) {
  const image = typeof entry.image === "string" ? entry.image : "";
  if (!image) return "";

  // Normalize to posix-style slashes (important for URLs/windows paths)
  const posixish = image.replaceAll("\\", "/");

  if (posixish.startsWith("images/")) {
    // Preserve subfolders, e.g. images/skylanders/tree_rex.png
    return posixish;
  }

  // Fall back to basename (old behaviour)
  const basename = path.posix.basename(posixish);
  return basename ? `images/${basename}` : "";
}

function toLiteAmiibo(entry) {
  return {
    amiiboSeries: entry.amiiboSeries ?? "",
    character: entry.character ?? "",
    gameSeries: entry.gameSeries ?? "",
    head: entry.head ?? "",
    image: normalizeImagePath(entry),
    name: entry.name ?? "",
    tail: entry.tail ?? "",
    type: entry.type ?? "amiibo",
  };
}

function toLiteSkylander(entry) {
  return {
    gameSeries: entry.gameSeries ?? entry.gameSeriesName ?? entry.game ?? "",
    figureId: entry.figureId ?? 0,
    variant: entry.variant ?? 0,
    sig: entry.sig ?? 0,
    image: normalizeImagePath(entry),
    name: entry.name ?? "",
    type: entry.type ?? "skylander",
  };
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeFileAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, filePath);
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listFilesRecursive(dir) {
  const out = [];
  const items = await fs.readdir(dir, { withFileTypes: true });
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) out.push(...(await listFilesRecursive(p)));
    else if (it.isFile()) out.push(p);
  }
  return out;
}

// New: copy directory recursively, preserving relative paths under dstDir
async function copyDirPreserve(srcDir, dstDir) {
  if (!(await exists(srcDir))) return;

  const files = await listFilesRecursive(srcDir);
  for (const src of files) {
    const rel = path.relative(srcDir, src);
    const dst = path.join(dstDir, rel);
    await ensureDir(path.dirname(dst));
    await fs.copyFile(src, dst);
  }
}

function parseBaseNamespace(parsed, keyName) {
  // Support either:
  // - { <keyName>: [...] }
  // - [ ... ]
  const entries = Array.isArray(parsed) ? parsed : parsed?.[keyName];
  if (!Array.isArray(entries)) {
    throw new Error(
      `tagBase.json must be an array or an object with a "${keyName}" array`
    );
  }
  return entries;
}

/**
 * Patches:
 * - All *.json under resources/patches/** are treated as arrays of entries.
 * - We split them into amiibo vs skylanders using:
 *    - entry.type === "skylander"  -> skylanders
 *    - else if entry.figureId/variant/sig present -> skylanders
 *    - else -> amiibo
 * - Any directory named "images" under patches is copied into dist/images (preserving folder structure)
 */
async function loadPatchEntriesAndImageDirs() {
  if (!(await exists(PATCHES_DIR))) {
    return {
      patchAmiiboEntries: [],
      patchSkylanderEntries: [],
      patchImageDirs: [],
    };
  }

  const files = await listFilesRecursive(PATCHES_DIR);

  const patchJsonFiles = files.filter((f) => f.toLowerCase().endsWith(".json"));
  const patchImageDirs = new Set();

  for (const f of files) {
    const parts = f.split(path.sep);
    const idx = parts.lastIndexOf("images");
    if (idx !== -1) {
      const imgDir = parts.slice(0, idx + 1).join(path.sep);
      patchImageDirs.add(imgDir);
    }
  }

  const patchAmiiboEntries = [];
  const patchSkylanderEntries = [];

  for (const file of patchJsonFiles) {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`Patch file must be a JSON array: ${file}`);
    }

    for (const e of parsed) {
      const type = (e?.type ?? "").toLowerCase();
      const looksSky =
        type === "skylander" ||
        typeof e?.figureId === "number" ||
        typeof e?.variant === "number" ||
        typeof e?.sig === "number";

      if (looksSky) patchSkylanderEntries.push(e);
      else patchAmiiboEntries.push(e);
    }
  }

  return {
    patchAmiiboEntries,
    patchSkylanderEntries,
    patchImageDirs: [...patchImageDirs],
  };
}

function validateNoDuplicates({ amiiboEntries, skylanderEntries }) {
  // Amiibo: head-tail
  {
    const seen = new Set();
    for (const e of amiiboEntries) {
      const head = e?.head ?? "";
      const tail = e?.tail ?? "";
      const key = `${head}-${tail}`;
      if (head !== "" && tail !== "" && seen.has(key)) {
        throw new Error(`Duplicate amiibo detected (head-tail): ${key}`);
      }
      seen.add(key);
    }
  }

  // Skylanders: sig (or fallback figureId-variant)
  {
    const seen = new Set();
    for (const e of skylanderEntries) {
      const sig =
        typeof e?.sig === "number" && Number.isFinite(e.sig) ? e.sig : null;
      const figureId =
        typeof e?.figureId === "number" && Number.isFinite(e.figureId)
          ? e.figureId
          : null;
      const variant =
        typeof e?.variant === "number" && Number.isFinite(e.variant)
          ? e.variant
          : null;

      const key =
        sig !== null
          ? `sig:${sig}`
          : `figureId-variant:${figureId ?? "?"}-${variant ?? "?"}`;

      if (seen.has(key)) {
        throw new Error(`Duplicate skylander detected (${key})`);
      }
      seen.add(key);
    }
  }
}

async function main() {
  await ensureDir(DIST_DIR);
  await ensureDir(DIST_IMAGES_DIR);

  // Load bases
  const amiiboRaw = await fs.readFile(AMIIBO_BASE_PATH, "utf8");
  const amiiboParsed = JSON.parse(amiiboRaw);
  const amiiboBaseEntries = parseBaseNamespace(amiiboParsed, "amiibo");

  const skyRaw = await fs.readFile(SKYLANDERS_BASE_PATH, "utf8");
  const skyParsed = JSON.parse(skyRaw);
  const skyBaseEntries = parseBaseNamespace(skyParsed, "skylanders");

  // Load patches
  const { patchAmiiboEntries, patchSkylanderEntries, patchImageDirs } =
    await loadPatchEntriesAndImageDirs();

  // Merge
  const amiiboEntries = [...amiiboBaseEntries, ...patchAmiiboEntries];
  const skylanderEntries = [...skyBaseEntries, ...patchSkylanderEntries];

  validateNoDuplicates({ amiiboEntries, skylanderEntries });

  // Copy images into dist/images (preserving structure)
  // 1) resources/images/**
  await copyDirPreserve(BASE_IMAGES_DIR, DIST_IMAGES_DIR);

  // 2) resources/patches/**/images/**
  for (const imgDir of patchImageDirs) {
    await copyDirPreserve(imgDir, DIST_IMAGES_DIR);
  }

  // Normalize image paths
  const normalizedAmiibo = amiiboEntries.map((e) => ({
    ...e,
    type: e.type ?? "amiibo",
    image: normalizeImagePath(e),
  }));

  const normalizedSkylanders = skylanderEntries.map((e) => ({
    ...e,
    type: e.type ?? "skylander",
    image: normalizeImagePath(e),
  }));

  // Full output (single tags file, namespaced)
  const fullOut = {
    amiibo: normalizedAmiibo,
    skylanders: normalizedSkylanders,
  };

  // Lite output
  const liteOut = {
    amiibo: normalizedAmiibo.map(toLiteAmiibo),
    skylanders: normalizedSkylanders.map(toLiteSkylander),
  };

  // Deterministic bytes -> sha1
  const fullJson = stableJsonStringify(fullOut);
  const fullBuf = Buffer.from(fullJson, "utf8");
  const fullSha = sha1Hex(fullBuf);

  const liteJson = stableJsonStringify(liteOut);
  const liteBuf = Buffer.from(liteJson, "utf8");
  const liteSha = sha1Hex(liteBuf);

  // Filenames
  const fullName = `tags.${fullSha}.json`;
  const liteName = `tags.lite.${liteSha}.json`;

  // Write versioned artifacts
  await writeFileAtomic(path.join(DIST_DIR, fullName), fullBuf);
  await writeFileAtomic(path.join(DIST_DIR, liteName), liteBuf);

  // Write "latest" convenience copies
  await writeFileAtomic(path.join(DIST_DIR, "tags.json"), fullBuf);
  await writeFileAtomic(path.join(DIST_DIR, "tags.lite.json"), liteBuf);

  // lastupdated.json
  const lastUpdated = {
    tags_sha1: fullSha,
    tags_lite_sha1: liteSha,
    timestamp: isoTimestampWithMillis(),
  };

  const lastJson = stableJsonStringify(lastUpdated);
  await writeFileAtomic(
    path.join(DIST_DIR, "lastupdated.json"),
    Buffer.from(lastJson, "utf8")
  );

  console.log("Built:");
  console.log(` - dist/${fullName}`);
  console.log(` - dist/${liteName}`);
  console.log(" - dist/tags.json");
  console.log(" - dist/tags.lite.json");
  console.log(" - dist/lastupdated.json");
  console.log(" - dist/images/** (copied, preserving folders)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
