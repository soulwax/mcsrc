#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const CACHE_DIR = path.join(REPO_ROOT, ".cache");
const TOOLS_DIR = path.join(CACHE_DIR, "tools");
const CLASSES_DIR = path.join(TOOLS_DIR, "classes");
const VERSIONS_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

const TOOL_DEPENDENCIES = [
    {
        name: "asm-9.9.1.jar",
        url: "https://repo1.maven.org/maven2/org/ow2/asm/asm/9.9.1/asm-9.9.1.jar",
    },
    {
        name: "asm-commons-9.9.1.jar",
        url: "https://repo1.maven.org/maven2/org/ow2/asm/asm-commons/9.9.1/asm-commons-9.9.1.jar",
    },
    {
        name: "asm-tree-9.9.1.jar",
        url: "https://repo1.maven.org/maven2/org/ow2/asm/asm-tree/9.9.1/asm-tree-9.9.1.jar",
    },
    {
        name: "asm-util-9.9.1.jar",
        url: "https://repo1.maven.org/maven2/org/ow2/asm/asm-util/9.9.1/asm-util-9.9.1.jar",
    },
    {
        name: "mapping-io-0.8.0.jar",
        url: "https://repo1.maven.org/maven2/net/fabricmc/mapping-io/0.8.0/mapping-io-0.8.0.jar",
    },
    {
        name: "mapping-io-extras-0.8.0.jar",
        url: "https://repo1.maven.org/maven2/net/fabricmc/mapping-io-extras/0.8.0/mapping-io-extras-0.8.0.jar",
    },
    {
        name: "vineflower-1.12.0.jar",
        url: "https://repo1.maven.org/maven2/org/vineflower/vineflower/1.12.0/vineflower-1.12.0.jar",
    },
];

async function downloadFile(url, destPath, expectedSha1 = null) {
    if (fs.existsSync(destPath)) {
        if (expectedSha1) {
            const hash = crypto.createHash("sha1").update(fs.readFileSync(destPath)).digest("hex");
            if (hash.toLowerCase() === expectedSha1.toLowerCase()) {
                return;
            }
        } else {
            return;
        }
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (expectedSha1) {
        const hash = crypto.createHash("sha1").update(buffer).digest("hex");
        if (hash.toLowerCase() !== expectedSha1.toLowerCase()) {
            throw new Error(`SHA1 mismatch for ${url}. Expected ${expectedSha1}, got ${hash}`);
        }
    }

    fs.writeFileSync(destPath, buffer);
}

function parseCliArgs() {
    const args = process.argv.slice(2);
    const options = {
        version: "latest",
        outDir: path.resolve(REPO_ROOT, "out"),
        clean: false,
        jarOnly: false,
        listVersions: false,
        help: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else if (arg === "--version" || arg === "-v") {
            options.version = args[++i];
        } else if (arg === "--out" || arg === "-o") {
            options.outDir = path.resolve(process.cwd(), args[++i]);
        } else if (arg === "--clean") {
            options.clean = true;
        } else if (arg === "--jar-only") {
            options.jarOnly = true;
        } else if (arg === "--list-versions" || arg === "-l") {
            options.listVersions = true;
        } else if (!arg.startsWith("-") && options.version === "latest") {
            options.version = arg;
        }
    }

    return options;
}

function printHelp() {
    console.log(`
mcsrc Decompiler Interop CLI
=============================
Downloads, remaps, and decompiles Minecraft client source code using mcsrc's pipeline.

Usage:
  node scripts/decompile.mjs [version] [options]
  npm run decompile -- [version] [options]

Options:
  -v, --version <version>    Minecraft version ID (e.g. 1.21.4, latest, snapshot) [default: latest release]
  -o, --out <dir>            Target output directory [default: ./out]
      --clean                Delete existing contents of output directory before decompiling
      --jar-only             Do not extract individual .java files, keep sources JAR only
  -l, --list-versions        List available recent Minecraft versions
  -h, --help                 Show this help message

Examples:
  node scripts/decompile.mjs 1.21.4
  node scripts/decompile.mjs 1.21.4 --out ./out
  node scripts/decompile.mjs latest --out ./build
`);
}

async function getVersionManifest() {
    console.log("[1/6] Fetching Mojang version manifest...");
    const response = await fetch(VERSIONS_URL);
    if (!response.ok) {
        throw new Error(`Failed to fetch version manifest: ${response.statusText}`);
    }
    const manifest = await response.json();

    const experimentalPath = path.join(REPO_ROOT, "src", "logic", "experimental_versions.json");
    if (fs.existsSync(experimentalPath)) {
        try {
            const expData = JSON.parse(fs.readFileSync(experimentalPath, "utf-8"));
            if (Array.isArray(expData.versions)) {
                manifest.versions.push(...expData.versions);
            }
        } catch (e) {
            console.warn("Could not load experimental versions:", e.message);
        }
    }

    return manifest;
}

function resolveVersion(manifest, requestedVersion) {
    if (requestedVersion === "latest" || requestedVersion === "release") {
        return manifest.versions.find(v => v.id === manifest.latest.release) || manifest.versions[0];
    }
    if (requestedVersion === "snapshot") {
        return manifest.versions.find(v => v.id === manifest.latest.snapshot) || manifest.versions[0];
    }
    const found = manifest.versions.find(v => v.id === requestedVersion);
    if (!found) {
        throw new Error(`Minecraft version '${requestedVersion}' was not found in Mojang manifest.`);
    }
    return found;
}

async function ensureTools() {
    console.log("[2/6] Ensuring bytecode & decompiler tools (ASM, mapping-io, Vineflower)...");
    fs.mkdirSync(TOOLS_DIR, { recursive: true });

    for (const dep of TOOL_DEPENDENCIES) {
        const targetPath = path.join(TOOLS_DIR, dep.name);
        if (!fs.existsSync(targetPath)) {
            console.log(`  Downloading ${dep.name}...`);
            await downloadFile(dep.url, targetPath);
        }
    }

    // Compile mcsrc Java remapper sources
    fs.mkdirSync(CLASSES_DIR, { recursive: true });
    const javaSrcDir = path.join(REPO_ROOT, "java", "src", "main", "java", "mcsrc");
    const javaFiles = fs.readdirSync(javaSrcDir)
        .filter(f => f.endsWith(".java"))
        .map(f => path.join(javaSrcDir, f));

    const classpath = TOOL_DEPENDENCIES
        .filter(d => !d.name.startsWith("vineflower"))
        .map(d => path.join(TOOLS_DIR, d.name))
        .join(path.delimiter);

    console.log("  Compiling mcsrc.RemapCli with javac...");
    const javacArgs = [
        "-cp", classpath,
        "-d", CLASSES_DIR,
        ...javaFiles
    ];

    const javacRes = spawnSync("javac", javacArgs, { stdio: "inherit" });
    if (javacRes.status !== 0) {
        throw new Error("Failed to compile mcsrc Java sources with javac.");
    }
}

async function prepareMinecraftAssets(versionEntry) {
    console.log(`[3/6] Fetching version metadata for '${versionEntry.id}'...`);
    const versionDir = path.join(CACHE_DIR, "minecraft", versionEntry.id);
    fs.mkdirSync(versionDir, { recursive: true });

    const verRes = await fetch(versionEntry.url);
    if (!verRes.ok) {
        throw new Error(`Failed to fetch version JSON from ${versionEntry.url}`);
    }
    const verData = await verRes.json();

    const clientDownload = verData.downloads?.client;
    if (!clientDownload) {
        throw new Error(`Version '${versionEntry.id}' does not have a client download.`);
    }

    const clientJarPath = path.join(versionDir, "client.jar");
    console.log(`  Downloading client.jar (${(clientDownload.size / 1024 / 1024).toFixed(1)} MB)...`);
    await downloadFile(clientDownload.url, clientJarPath, clientDownload.sha1);

    const mappingsDownload = verData.downloads?.client_mappings;
    let mappingsPath = null;
    if (mappingsDownload) {
        mappingsPath = path.join(versionDir, "client_mappings.txt");
        console.log(`  Downloading client_mappings.txt (${(mappingsDownload.size / 1024 / 1024).toFixed(1)} MB)...`);
        await downloadFile(mappingsDownload.url, mappingsPath, mappingsDownload.sha1);
    } else {
        console.log(`  Version '${versionEntry.id}' does not have official mappings (will decompile directly).`);
    }

    return {
        id: versionEntry.id,
        clientJarPath,
        mappingsPath,
        clientSha1: clientDownload.sha1,
        mappingsSha1: mappingsDownload?.sha1,
    };
}

function remapJar(assets) {
    const versionDir = path.join(CACHE_DIR, "minecraft", assets.id);
    const remappedJarPath = path.join(versionDir, "client-remapped.jar");

    if (!assets.mappingsPath) {
        console.log("[4/6] No mappings provided; using raw client JAR.");
        return assets.clientJarPath;
    }

    if (fs.existsSync(remappedJarPath)) {
        console.log("[4/6] Using cached remapped JAR:", remappedJarPath);
        return remappedJarPath;
    }

    console.log("[4/6] Remapping client.jar using mcsrc.RemapCli...");
    const classpath = [
        CLASSES_DIR,
        ...TOOL_DEPENDENCIES
            .filter(d => !d.name.startsWith("vineflower"))
            .map(d => path.join(TOOLS_DIR, d.name))
    ].join(path.delimiter);

    const javaArgs = [
        "-cp", classpath,
        "mcsrc.RemapCli",
        assets.clientJarPath,
        assets.mappingsPath,
        remappedJarPath,
    ];

    const javaRes = spawnSync("java", javaArgs, { stdio: "inherit" });
    if (javaRes.status !== 0) {
        throw new Error("Remapping failed.");
    }

    return remappedJarPath;
}

function decompileJar(inputJarPath, versionId, outDir, options) {
    console.log(`[5/6] Decompiling JAR with Vineflower 1.12.0...`);
    fs.mkdirSync(outDir, { recursive: true });

    const sourcesJarPath = path.join(outDir, `minecraft-${versionId}-sources.jar`);
    const vineflowerJar = path.join(TOOLS_DIR, "vineflower-1.12.0.jar");

    const vfArgs = [
        "-jar", vineflowerJar,
        "--mark-corresponding-synthetics=1",
        "--log-level=warn",
        inputJarPath,
        sourcesJarPath
    ];

    console.log(`  Executing: java ${vfArgs.join(" ")}`);
    const startDecompile = performance.now();
    const vfRes = spawnSync("java", vfArgs, { stdio: "inherit" });
    if (vfRes.status !== 0) {
        throw new Error("Vineflower decompilation failed.");
    }
    const elapsedDecompile = ((performance.now() - startDecompile) / 1000).toFixed(2);
    console.log(`  Decompiled sources JAR created in ${elapsedDecompile}s: ${sourcesJarPath}`);

    return sourcesJarPath;
}

function extractSources(sourcesJarPath, outDir, versionId, assets) {
    console.log("[6/6] Extracting decompiled source files to output directory...");
    const extractedDir = path.join(outDir, "sources");
    fs.mkdirSync(extractedDir, { recursive: true });

    // Extract using jar command or PowerShell Expand-Archive / 7zip / python / node unzip
    // Let's use PowerShell's Expand-Archive or jar xf
    console.log(`  Extracting ${sourcesJarPath} -> ${extractedDir}`);
    const jarToolRes = spawnSync("jar", ["xf", path.resolve(sourcesJarPath)], { cwd: extractedDir });
    let totalFiles = 0;

    if (jarToolRes.status !== 0) {
        // Fallback to powershell tar or expand
        const psRes = spawnSync("tar", ["-xf", path.resolve(sourcesJarPath), "-C", path.resolve(extractedDir)], { stdio: "inherit" });
        if (psRes.status !== 0) {
            console.warn("  Notice: Could not automatically extract JAR. The sources JAR is ready at:", sourcesJarPath);
        }
    }

    function countFiles(dir) {
        let count = 0;
        if (!fs.existsSync(dir)) return 0;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                count += countFiles(path.join(dir, entry.name));
            } else if (entry.isFile() && entry.name.endsWith(".java")) {
                count++;
            }
        }
        return count;
    }

    totalFiles = countFiles(extractedDir);

    const info = {
        version: versionId,
        decompiledAt: new Date().toISOString(),
        clientSha1: assets.clientSha1,
        mappingsSha1: assets.mappingsSha1 || null,
        sourcesJar: path.basename(sourcesJarPath),
        totalJavaFiles: totalFiles,
        extractedDirectory: path.relative(outDir, extractedDir),
    };

    fs.writeFileSync(path.join(outDir, "decompiled-info.json"), JSON.stringify(info, null, 2));
    console.log(`\n========================================================================`);
    console.log(` Decompilation Complete!`);
    console.log(` Minecraft Version: ${versionId}`);
    console.log(` Output Directory:  ${outDir}`);
    console.log(` Sources JAR:       ${sourcesJarPath}`);
    console.log(` Extracted Sources: ${extractedDir} (${totalFiles} .java files)`);
    console.log(`========================================================================\n`);
}

async function main() {
    const options = parseCliArgs();

    if (options.help) {
        printHelp();
        return;
    }

    const manifest = await getVersionManifest();

    if (options.listVersions) {
        console.log(`\nRecent Minecraft Versions (total: ${manifest.versions.length}):`);
        manifest.versions.slice(0, 30).forEach(v => {
            console.log(`  ${v.id.padEnd(20)} [${v.type}] - ${v.releaseTime}`);
        });
        return;
    }

    const versionEntry = resolveVersion(manifest, options.version);
    console.log(`Targeting Minecraft version: ${versionEntry.id} (${versionEntry.type})`);

    if (options.clean && fs.existsSync(options.outDir)) {
        console.log(`Cleaning output directory: ${options.outDir}`);
        fs.rmSync(options.outDir, { recursive: true, force: true });
    }

    await ensureTools();
    const assets = await prepareMinecraftAssets(versionEntry);
    const remappedJarPath = remapJar(assets);
    const sourcesJarPath = decompileJar(remappedJarPath, versionEntry.id, options.outDir, options);

    if (!options.jarOnly) {
        extractSources(sourcesJarPath, options.outDir, versionEntry.id, assets);
    }
}

main().catch(err => {
    console.error("\n[Error]", err.message || err);
    process.exit(1);
});
