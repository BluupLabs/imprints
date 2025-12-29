// scripts/build-data.mjs
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.cwd();

const RESOURCES_DIR = path.join(ROOT, "resources");
const BASE_DIR = path.join(RESOURCES_DIR, "base");
const DIST_DIR = path.join(ROOT, "dist");

const TAG_BASE_PATH = path.join(BASE_DIR, "tagBase.json");
const PATCHES_DIR = path.join(RESOURCES_DIR, "patches");
const BASE_IMAGES_DIR = path.join(RESOURCES_DIR, "images");

const DIST_IMAGES_DIR = path.join(DIST_DIR, "images");

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

function normalizeImagePath(entry) {
  const image = typeof entry.image === "string" ? entry.image : "";
  const basename = image ? path.posix.basename(image) : "";
  return basename ? `images/${basename}` : "";
}

function toLiteEntry(entry) {
  return {
    amiiboSeries: entry.amiiboSeries ?? "",
    character: entry.character ?? "",
    gameSeries: entry.gameSeries ?? "",
    head: entry.head ?? "",
    image: normalizeImagePath(entry),
    name: entry.name ?? "",
    tail: entry.tail ?? "",
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

function parseBaseAmiibo(parsed) {
  // Support either:
  // - { amiibo: [...] }  (original AmiiboAPI structure)
  // - [ ... ]            (raw array)
  const entries = Array.isArray(parsed) ? parsed : parsed.amiibo;
  if (!Array.isArray(entries)) {
    throw new Error(
      `tagBase.json must be an array or an object with an "amiibo" array`
    );
  }
  return entries;
}

async function loadPatchEntriesAndImageDirs() {
  // We support patch structure like:
  // resources/patches/**/<something>.json
  // resources/patches/**/images/*
  //
  // All *.json under patches are treated as patch data files.
  // All "images" directories under patches are copied into dist/images.
  if (!(await exists(PATCHES_DIR))) {
    return { patchEntries: [], patchImageDirs: [] };
  }

  const files = await listFilesRecursive(PATCHES_DIR);

  const patchJsonFiles = files.filter((f) => f.toLowerCase().endsWith(".json"));
  const patchImageDirs = new Set();

  // Any directory named "images" under patches gets copied.
  for (const f of files) {
    // We only collected files; derive their parent dirs and walk up for ".../images"
    const parts = f.split(path.sep);
    const idx = parts.lastIndexOf("images");
    if (idx !== -1) {
      const imgDir = parts.slice(0, idx + 1).join(path.sep);
      patchImageDirs.add(imgDir);
    }
  }

  const patchEntries = [];
  for (const file of patchJsonFiles) {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`Patch file must be a JSON array: ${file}`);
    }
    patchEntries.push(...parsed);
  }

  return { patchEntries, patchImageDirs: [...patchImageDirs] };
}

function validateNoDuplicates(entries) {
  const seen = new Set();
  for (const e of entries) {
    const head = e?.head ?? "";
    const tail = e?.tail ?? "";
    const key = `${head}-${tail}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate amiibo detected (head-tail): ${key}`);
    }
    seen.add(key);
  }
}

async function copyDirFlat(srcDir, dstDir) {
  if (!(await exists(srcDir))) return;

  const items = await fs.readdir(srcDir, { withFileTypes: true });
  for (const it of items) {
    if (!it.isFile()) continue;

    const src = path.join(srcDir, it.name);
    const dst = path.join(dstDir, it.name);

    await fs.copyFile(src, dst);
  }
}

async function main() {
  await ensureDir(DIST_DIR);
  await ensureDir(DIST_IMAGES_DIR);

  // Load base
  const baseRaw = await fs.readFile(TAG_BASE_PATH, "utf8");
  const baseParsed = JSON.parse(baseRaw);
  const baseEntries = parseBaseAmiibo(baseParsed);

  // Load patches
  const { patchEntries, patchImageDirs } = await loadPatchEntriesAndImageDirs();

  // Merge
  const allEntries = [...baseEntries, ...patchEntries];
  validateNoDuplicates(allEntries);

  // Copy images into dist/images
  // 1) resources/images/*
  await copyDirFlat(BASE_IMAGES_DIR, DIST_IMAGES_DIR);

  // 2) resources/patches/**/images/*
  for (const imgDir of patchImageDirs) {
    await copyDirFlat(imgDir, DIST_IMAGES_DIR);
  }

  // Build outputs
  // Full output:
  // - preserve top-level shape if it was object-based; otherwise output { amiibo: [...] }.
  const normalizedFullEntries = allEntries.map((e) => ({
    ...e,
    image: normalizeImagePath(e),
  }));

  const fullOut = Array.isArray(baseParsed)
    ? { amiibo: normalizedFullEntries }
    : { ...baseParsed, amiibo: normalizedFullEntries };

  // Lite output
  const liteOut = {
    amiibo: normalizedFullEntries.map(toLiteEntry),
  };

  // Deterministic bytes -> sha1
  const fullJson = stableJsonStringify(fullOut);
  const fullBuf = Buffer.from(fullJson, "utf8");
  const fullSha = sha1Hex(fullBuf);

  const liteJson = stableJsonStringify(liteOut);
  const liteBuf = Buffer.from(liteJson, "utf8");
  const liteSha = sha1Hex(liteBuf);

  // Filenames
  const fullName = `amiibo.${fullSha}.json`;
  const liteName = `amiibo.lite.${liteSha}.json`;

  // Write versioned artifacts
  await writeFileAtomic(path.join(DIST_DIR, fullName), fullBuf);
  await writeFileAtomic(path.join(DIST_DIR, liteName), liteBuf);

  // Write "latest" convenience copies
  await writeFileAtomic(path.join(DIST_DIR, "amiibo.json"), fullBuf);
  await writeFileAtomic(path.join(DIST_DIR, "amiibo.lite.json"), liteBuf);

  // lastupdated.json
  const lastUpdated = {
    amiibo_sha1: fullSha,
    amiibo_lite_sha1: liteSha,
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
  console.log(" - dist/amiibo.json");
  console.log(" - dist/amiibo.lite.json");
  console.log(" - dist/lastupdated.json");
  console.log(" - dist/images/* (copied)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
