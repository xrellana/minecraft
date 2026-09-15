#!/usr/bin/env node
// Builds src/ into WandToolkit.mcpack.
//
//   node tools/build.mjs           write the .mcpack
//   node tools/build.mjs --check   verify the committed .mcpack is up to date
//                                  (exit 1 if not) without writing anything
//
// The output is deterministic for a given Node build: entries are emitted in
// sorted order with a fixed timestamp, so rebuilding unchanged sources does
// not produce a spurious git diff.
//
// --check deliberately compares CONTENT (entry names, sizes and CRCs read
// from the archive's central directory) rather than raw file bytes, because
// zlib's compressed output can differ between Node versions. Comparing bytes
// would fail on CI purely because it runs a different Node than the machine
// that built the pack.

import { deflateRawSync } from "node:zlib";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const OUTPUT = join(ROOT, "WandToolkit.mcpack");

// The one place the pack version is written is src/manifest.json; this token
// in the sources is replaced with it at build time.
const VERSION_PLACEHOLDER = "__PACK_VERSION__";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function loadManifest() {
    const manifest = JSON.parse(readFileSync(join(SRC, "manifest.json"), "utf8"));
    const header = manifest.header?.version;
    if (!Array.isArray(header) || header.length !== 3) {
        throw new Error("manifest.header.version must be a [major, minor, patch] array");
    }
    for (const module of manifest.modules ?? []) {
        if (String(module.version) !== String(header)) {
            throw new Error(
                `manifest module version [${module.version}] does not match ` +
                `header version [${header}]`
            );
        }
    }
    return { manifest, version: header.join(".") };
}

// ---------------------------------------------------------------------------
// Source collection
// ---------------------------------------------------------------------------

function walk(dir, files = []) {
    for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, files);
        else files.push(full);
    }
    return files;
}

function collectEntries(version) {
    let substitutions = 0;
    const entries = walk(SRC).map((full) => {
        // Zip paths are always forward-slashed, whatever the host OS uses.
        const name = relative(SRC, full).split(sep).join("/");
        let data = readFileSync(full);
        if (name.endsWith(".js") && data.includes(VERSION_PLACEHOLDER)) {
            data = Buffer.from(
                data.toString("utf8").split(VERSION_PLACEHOLDER).join(version),
                "utf8"
            );
            substitutions++;
        }
        return { name, data };
    });
    if (substitutions === 0) {
        throw new Error(
            `no source file contains ${VERSION_PLACEHOLDER}; the pack would ` +
            `report the wrong version in game`
        );
    }
    return entries;
}

// ---------------------------------------------------------------------------
// Minimal deterministic ZIP writer
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

// Fixed MS-DOS timestamp (1980-01-01 00:00:00), the earliest the format can
// represent — the point is only that it never varies between builds.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

const DEFLATE = 8;
const VERSION_NEEDED = 20;

function buildZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, "utf8");
        const compressed = deflateRawSync(data, { level: 9 });
        const crc = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); // local file header signature
        local.writeUInt16LE(VERSION_NEEDED, 4);
        local.writeUInt16LE(0, 6); // general purpose flags
        local.writeUInt16LE(DEFLATE, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28); // extra field length
        locals.push(local, nameBuf, compressed);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); // central directory signature
        central.writeUInt16LE(VERSION_NEEDED, 4); // version made by
        central.writeUInt16LE(VERSION_NEEDED, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(DEFLATE, 10);
        central.writeUInt16LE(DOS_TIME, 12);
        central.writeUInt16LE(DOS_DATE, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30); // extra field length
        central.writeUInt16LE(0, 32); // file comment length
        central.writeUInt16LE(0, 34); // disk number start
        central.writeUInt16LE(0, 36); // internal attributes
        central.writeUInt32LE(0, 38); // external attributes
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuf);

        offset += local.length + nameBuf.length + compressed.length;
    }

    const centralBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
    eocd.writeUInt16LE(0, 4); // this disk
    eocd.writeUInt16LE(0, 6); // disk with central directory
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20); // comment length

    return Buffer.concat([...locals, centralBuf, eocd]);
}

// ---------------------------------------------------------------------------
// ZIP reader: just enough of the central directory to list what an existing
// archive contains, without decompressing anything.
// ---------------------------------------------------------------------------

function readZipManifest(zip) {
    // Locate the end-of-central-directory record. The build writes no archive
    // comment, so it sits at the very end, but scan backwards regardless.
    let eocd = -1;
    for (let i = zip.length - 22; i >= 0; i--) {
        if (zip.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd === -1) throw new Error("not a ZIP archive (no end-of-central-directory record)");

    const count = zip.readUInt16LE(eocd + 10);
    let offset = zip.readUInt32LE(eocd + 16);

    const entries = [];
    for (let i = 0; i < count; i++) {
        if (zip.readUInt32LE(offset) !== 0x02014b50) {
            throw new Error(`corrupt central directory at byte ${offset}`);
        }
        const crc = zip.readUInt32LE(offset + 16);
        const size = zip.readUInt32LE(offset + 24);
        const nameLen = zip.readUInt16LE(offset + 28);
        const extraLen = zip.readUInt16LE(offset + 30);
        const commentLen = zip.readUInt16LE(offset + 32);
        const name = zip.toString("utf8", offset + 46, offset + 46 + nameLen);
        entries.push({ name, size, crc });
        offset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

function describeEntries(entries) {
    return entries
        .map((e) => `${e.name}\t${e.size}\t${e.crc}`)
        .sort()
        .join("\n");
}

// ---------------------------------------------------------------------------

function runCheck(entries, version) {
    if (!existsSync(OUTPUT)) {
        console.error("✗ WandToolkit.mcpack is missing; run: npm run build");
        process.exit(1);
    }

    const expected = entries.map((e) => ({
        name: e.name,
        size: e.data.length,
        crc: crc32(e.data),
    }));

    let actual;
    try {
        actual = readZipManifest(readFileSync(OUTPUT));
    } catch (e) {
        console.error(`✗ WandToolkit.mcpack is unreadable: ${e.message}`);
        process.exit(1);
    }

    if (describeEntries(actual) === describeEntries(expected)) {
        console.log(`✓ WandToolkit.mcpack matches src/ (v${version}, ${expected.length} files)`);
        return;
    }

    console.error("✗ WandToolkit.mcpack is out of date with src/; run: npm run build\n");
    const actualByName = new Map(actual.map((e) => [e.name, e]));
    const expectedByName = new Map(expected.map((e) => [e.name, e]));
    for (const { name } of expected) {
        const got = actualByName.get(name);
        if (!got) console.error(`    missing from pack: ${name}`);
        else if (got.crc !== expectedByName.get(name).crc) {
            console.error(`    differs from src/:  ${name}`);
        }
    }
    for (const { name } of actual) {
        if (!expectedByName.has(name)) console.error(`    stale in pack:      ${name}`);
    }
    process.exit(1);
}

function main() {
    const { manifest, version } = loadManifest();
    const entries = collectEntries(version);

    if (process.argv.includes("--check")) {
        runCheck(entries, version);
        return;
    }

    const zip = buildZip(entries);

    writeFileSync(OUTPUT, zip);
    console.log(
        `✓ ${manifest.header.name} v${version} → WandToolkit.mcpack ` +
        `(${entries.length} files, ${zip.length} bytes)`
    );
}

main();
