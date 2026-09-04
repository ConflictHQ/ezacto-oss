import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const snapshotKind = "ezacto-container-physical-snapshot";
const snapshotVersion = 1;
const dockerName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const imageName = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$/u;
const attachmentFile = /^attachments\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/u;
const attachmentDirectory =
  /^(?:attachments|attachments\/sha256|attachments\/sha256\/[0-9a-f]{2})$/u;
const sqliteHeader = Buffer.from("SQLite format 3\u0000", "binary");

const fail = (message) => {
  throw new Error(message);
};

const missing = (error) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const portablePath = (root, path) => relative(root, path).split(sep).join("/");

const sha256 = (path) =>
  new Promise((resolvePromise, rejectPromise) => {
    const digest = createHash("sha256");
    const input = createReadStream(path);
    input.once("error", rejectPromise);
    input.on("data", (chunk) => digest.update(chunk));
    input.once("end", () => resolvePromise(digest.digest("hex")));
  });

const readHeader = async (path, length) => {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

const securePath = async (path) => {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) fail(`${path} must not be a symbolic link`);
  return metadata;
};

const assertSnapshotPath = (path, name) => {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path === "/" ||
    path.includes(",") ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    fail(
      `${name} must be a normalized absolute path without commas or controls`,
    );
  }
};

const assertCanonicalDirectory = async (path, name) => {
  const metadata = await securePath(path);
  if (!metadata.isDirectory() || (await realpath(path)) !== path) {
    fail(`${name} must be a canonical directory without symbolic links`);
  }
};

const assertExactKeys = (value, expected, name) => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${name} has unexpected fields`);
  }
};

const walkAttachments = async (root, directory, files) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const logical = portablePath(root, path);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink())
      fail(`${logical} must not be a symbolic link`);
    if (metadata.isDirectory()) {
      if (!attachmentDirectory.test(logical)) {
        fail(`${logical} is not a content-addressed attachment directory`);
      }
      await walkAttachments(root, path, files);
      continue;
    }
    if (!metadata.isFile()) fail(`${logical} must be a regular file`);
    const match = attachmentFile.exec(logical);
    if (match === null || match[1] !== match[2].slice(0, 2)) {
      fail(`${logical} is not a content-addressed attachment object`);
    }
    const digest = await sha256(path);
    if (digest !== match[2]) fail(`${logical} content does not match its key`);
    files.push({ path: logical, byte_size: metadata.size, sha256: digest });
  }
};

const durableInventory = async (root) => {
  await assertCanonicalDirectory(root, "snapshot root");

  const names = (await readdir(root)).sort();
  const allowed = ["attachments", "db.sqlite", "snapshot.json"];
  for (const name of names) {
    if (!allowed.includes(name))
      fail(`snapshot contains unexpected root path ${name}`);
  }
  if (!names.includes("db.sqlite") || !names.includes("attachments")) {
    fail("snapshot must contain db.sqlite and attachments");
  }

  const databasePath = join(root, "db.sqlite");
  const database = await securePath(databasePath);
  if (!database.isFile()) fail("db.sqlite must be a regular file");
  const header = await readHeader(databasePath, sqliteHeader.length);
  if (!header.equals(sqliteHeader)) fail("db.sqlite is not a SQLite database");

  const attachmentsPath = join(root, "attachments");
  const attachments = await securePath(attachmentsPath);
  if (!attachments.isDirectory()) fail("attachments must be a directory");

  const files = [
    {
      path: "db.sqlite",
      byte_size: database.size,
      sha256: await sha256(databasePath),
    },
  ];
  await walkAttachments(root, attachmentsPath, files);
  return files.sort((left, right) => left.path.localeCompare(right.path));
};

export const createPhysicalSnapshotMetadata = async (
  root,
  source,
  createdAt = new Date().toISOString(),
) => {
  assertExactKeys(
    source,
    ["container", "image", "image_id", "volume"],
    "snapshot source",
  );
  return {
    schema_version: snapshotVersion,
    kind: snapshotKind,
    created_at: createdAt,
    source,
    files: await durableInventory(root),
  };
};

const parseMetadata = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("snapshot.json must contain an object");
  }
  assertExactKeys(
    value,
    ["schema_version", "kind", "created_at", "source", "files"],
    "snapshot.json",
  );
  if (value.schema_version !== snapshotVersion || value.kind !== snapshotKind) {
    fail("snapshot.json kind or schema version is unsupported");
  }
  if (
    typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at))
  ) {
    fail("snapshot.json created_at is invalid");
  }
  if (
    value.source === null ||
    typeof value.source !== "object" ||
    Array.isArray(value.source)
  ) {
    fail("snapshot.json source is invalid");
  }
  assertExactKeys(
    value.source,
    ["container", "image", "image_id", "volume"],
    "snapshot source",
  );
  for (const field of ["container", "image", "image_id", "volume"]) {
    if (
      typeof value.source[field] !== "string" ||
      value.source[field].length === 0
    ) {
      fail(`snapshot source ${field} is invalid`);
    }
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    fail("snapshot.json files are invalid");
  }
  for (const file of value.files) {
    if (file === null || typeof file !== "object" || Array.isArray(file)) {
      fail("snapshot.json file entry is invalid");
    }
    assertExactKeys(file, ["path", "byte_size", "sha256"], "snapshot file");
    if (
      typeof file.path !== "string" ||
      !Number.isSafeInteger(file.byte_size) ||
      file.byte_size < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(file.sha256)
    ) {
      fail("snapshot.json file entry is invalid");
    }
  }
  return value;
};

const sameInventory = (actual, expected) =>
  JSON.stringify(actual) === JSON.stringify(expected);

export const verifyPhysicalSnapshot = async (root) => {
  assertSnapshotPath(root, "bundle");
  const metadataPath = join(root, "snapshot.json");
  const metadataFile = await securePath(metadataPath);
  if (!metadataFile.isFile()) fail("snapshot.json must be a regular file");
  let decoded;
  try {
    decoded = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch {
    fail("snapshot.json is not valid JSON");
  }
  const metadata = parseMetadata(decoded);
  const files = await durableInventory(root);
  if (!sameInventory(files, metadata.files)) {
    fail("snapshot file inventory or checksum does not match snapshot.json");
  }
  return metadata;
};

const run = (program, args) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(program, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => {
      const next = current + chunk;
      if (next.length > 2_000_000) fail(`${program} produced excessive output`);
      return next;
    };
    child.stdout.on("data", (chunk) => (stdout = append(stdout, chunk)));
    child.stderr.on("data", (chunk) => (stderr = append(stderr, chunk)));
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        rejectPromise(
          new Error(
            `${program} ${args[0] ?? ""} failed (${code}): ${stderr.trim()}`,
          ),
        );
      }
    });
  });

const docker = (args) => run("docker", args);

const containerInspection = async (name) => {
  const result = await docker(["container", "inspect", name]);
  let decoded;
  try {
    decoded = JSON.parse(result.stdout);
  } catch {
    fail("Docker returned invalid container inspection JSON");
  }
  if (!Array.isArray(decoded) || decoded.length !== 1) {
    fail("Docker did not resolve exactly one source container");
  }
  return decoded[0];
};

const volumeReferences = async (volume) => {
  const listed = await docker([
    "container",
    "ls",
    "--all",
    "--quiet",
    "--no-trunc",
    "--filter",
    `volume=${volume}`,
  ]);
  const ids = listed.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (ids.some((id) => !/^[0-9a-f]{12,64}$/u.test(id))) {
    fail("Docker returned an invalid container reference");
  }
  if (ids.length === 0) return [];

  const result = await docker(["container", "inspect", ...ids]);
  let decoded;
  try {
    decoded = JSON.parse(result.stdout);
  } catch {
    fail("Docker returned invalid volume-reference inspection JSON");
  }
  if (!Array.isArray(decoded) || decoded.length !== ids.length) {
    fail("Docker did not resolve every volume reference");
  }
  return decoded.filter(
    (inspection) =>
      Array.isArray(inspection.Mounts) &&
      inspection.Mounts.some(
        (mount) => mount.Type === "volume" && mount.Name === volume,
      ),
  );
};

const verifySqliteWithImage = async (root, image) => {
  const verifier = String.raw`
const fs = require('node:fs')
const Database = require('better-sqlite3')
const path = '/tmp/ezacto-snapshot-verify.sqlite'
fs.copyFileSync('/snapshot/db.sqlite', path, fs.constants.COPYFILE_EXCL)
const database = new Database(path, { fileMustExist: true })
try {
  database.pragma('query_only = ON')
  if (database.pragma('quick_check(1)', { simple: true }) !== 'ok') throw new Error('SQLite quick_check failed')
  if (database.pragma('foreign_key_check').length !== 0) throw new Error('SQLite foreign_key_check failed')
} finally {
  database.close()
}
`;
  await docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    "0:0",
    "--mount",
    `type=bind,source=${root},target=/snapshot,readonly`,
    "--entrypoint",
    "node",
    image,
    "-e",
    verifier,
  ]);
};

const backup = async ({ container, output }) => {
  if (!dockerName.test(container)) fail("container name is invalid");
  assertSnapshotPath(output, "output");
  try {
    await lstat(output);
    fail("output path already exists");
  } catch (error) {
    if (!missing(error)) throw error;
  }

  const inspection = await containerInspection(container);
  if (
    inspection.State?.Status !== "exited" ||
    inspection.State?.Running !== false
  ) {
    fail("source container must be cleanly stopped before backup");
  }
  const mounts = Array.isArray(inspection.Mounts)
    ? inspection.Mounts.filter((mount) => mount.Destination === "/data")
    : [];
  if (
    mounts.length !== 1 ||
    mounts[0].Type !== "volume" ||
    mounts[0].RW !== true ||
    typeof mounts[0].Name !== "string" ||
    !dockerName.test(mounts[0].Name)
  ) {
    fail(
      "source container must use one writable named volume mounted at /data",
    );
  }
  const references = await volumeReferences(mounts[0].Name);
  if (
    references.length !== 1 ||
    typeof inspection.Id !== "string" ||
    references[0]?.Id !== inspection.Id
  ) {
    fail(
      "source volume must be referenced only by the stopped source container",
    );
  }
  if (
    typeof inspection.Config?.Image !== "string" ||
    !imageName.test(inspection.Config.Image) ||
    inspection.Config.Image.startsWith("-")
  ) {
    fail("source container image is unavailable");
  }
  if (typeof inspection.Image !== "string" || inspection.Image === "") {
    fail("source container image id is unavailable");
  }

  await assertCanonicalDirectory(dirname(output), "output parent");
  await mkdir(output, { mode: 0o700 });
  try {
    await docker(["container", "cp", `${container}:/data/.`, output]);
    await verifySqliteWithImage(output, inspection.Config.Image);
    const metadata = await createPhysicalSnapshotMetadata(output, {
      container,
      volume: mounts[0].Name,
      image: inspection.Config.Image,
      image_id: inspection.Image,
    });
    await writeFile(
      join(output, "snapshot.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await verifyPhysicalSnapshot(output);
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(`physical snapshot verified: ${output}\n`);
};

const restoreHelper = String.raw`
const fs = require('node:fs')
const source = '/restore'
const target = '/data'
if (fs.readdirSync(target).length !== 0) throw new Error('target volume is not empty')
const copy = (from, to) => {
  const metadata = fs.lstatSync(from)
  if (metadata.isSymbolicLink()) throw new Error('snapshot contains a symbolic link')
  if (metadata.isDirectory()) {
    fs.mkdirSync(to, { mode: 0o700 })
    for (const name of fs.readdirSync(from)) copy(from + '/' + name, to + '/' + name)
    return
  }
  if (!metadata.isFile()) throw new Error('snapshot contains a special file')
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL)
}
copy(source + '/db.sqlite', target + '/db.sqlite')
copy(source + '/attachments', target + '/attachments')
const secure = (path) => {
  const metadata = fs.lstatSync(path)
  if (metadata.isSymbolicLink()) throw new Error('restored data contains a symbolic link')
  fs.chownSync(path, 1000, 1000)
  fs.chmodSync(path, metadata.isDirectory() ? 0o700 : 0o600)
  if (metadata.isDirectory()) {
    for (const name of fs.readdirSync(path)) secure(path + '/' + name)
  }
}
secure(target)
`;

const verifyRestoredVolume = async ({ bundle, volume, image, expected }) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ezacto-restore-verify-"));
  const extracted = join(temporaryRoot, "data");
  const verifier = `ezacto-restore-verify-${process.pid}-${randomBytes(6).toString("hex")}`;
  let created = false;
  try {
    await mkdir(extracted, { mode: 0o700 });
    await docker([
      "container",
      "create",
      "--name",
      verifier,
      "--mount",
      `type=volume,source=${volume},target=/data`,
      "--entrypoint",
      "node",
      image,
      "-e",
      "process.exit(0)",
    ]);
    created = true;
    await docker(["container", "cp", `${verifier}:/data/.`, extracted]);
    const actual = await durableInventory(extracted);
    if (!sameInventory(actual, expected.files)) {
      fail("restored volume does not match the snapshot checksums");
    }
  } finally {
    if (created) {
      await docker(["container", "rm", "--force", verifier]).catch(
        () => undefined,
      );
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  process.stdout.write(
    `restored volume verified against ${bundle}: ${volume}\n`,
  );
};

const restore = async ({ bundle, volume, image }) => {
  assertSnapshotPath(bundle, "bundle");
  if (!dockerName.test(volume)) fail("volume name is invalid");
  if (!imageName.test(image) || image.startsWith("-"))
    fail("image name is invalid");
  const metadata = await verifyPhysicalSnapshot(bundle);
  await docker(["volume", "inspect", volume]);
  if ((await volumeReferences(volume)).length !== 0) {
    fail("target volume must not be referenced by any container");
  }
  await docker([
    "run",
    "--rm",
    "--user",
    "0:0",
    "--mount",
    `type=volume,source=${volume},target=/data`,
    "--mount",
    `type=bind,source=${bundle},target=/restore,readonly`,
    "--entrypoint",
    "node",
    image,
    "-e",
    restoreHelper,
  ]);
  await verifyRestoredVolume({ bundle, volume, image, expected: metadata });
};

const optionsFor = (args) => {
  if (args.length % 2 !== 0) fail("options must be --name value pairs");
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!/^--[a-z-]+$/u.test(option) || value === undefined || value === "") {
      fail("options must be --name value pairs");
    }
    const name = option.slice(2);
    if (options[name] !== undefined)
      fail(`${option} was supplied more than once`);
    options[name] = value;
  }
  return options;
};

const requiredOptions = (options, names) => {
  assertExactKeys(options, names, "command options");
  for (const name of names) {
    if (typeof options[name] !== "string") fail(`--${name} is required`);
  }
  return options;
};

const usage = `Usage:
  node scripts/container-physical-snapshot.mjs backup --container NAME --output /absolute/path
  node scripts/container-physical-snapshot.mjs verify --bundle /absolute/path
  node scripts/container-physical-snapshot.mjs restore --bundle /absolute/path --volume NAME --image IMAGE
`;

const main = async () => {
  const [command, ...args] = process.argv.slice(2);
  if (command === "backup") {
    await backup(requiredOptions(optionsFor(args), ["container", "output"]));
    return;
  }
  if (command === "verify") {
    const { bundle } = requiredOptions(optionsFor(args), ["bundle"]);
    await verifyPhysicalSnapshot(bundle);
    process.stdout.write(`physical snapshot verified: ${bundle}\n`);
    return;
  }
  if (command === "restore") {
    await restore(
      requiredOptions(optionsFor(args), ["bundle", "volume", "image"]),
    );
    return;
  }
  process.stderr.write(usage);
  process.exitCode = 2;
};

const invoked = process.argv[1];
if (
  invoked !== undefined &&
  import.meta.url === pathToFileURL(resolve(invoked)).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "snapshot operation failed"}\n`,
    );
    process.exitCode = 1;
  });
}
