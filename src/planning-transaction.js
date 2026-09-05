import { createHash } from "node:crypto";
import {
  linkSync,
  lstatSync,
  readFileSync,
  mkdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export const ACTIVE_SPECIFICATION_PATH = ".ralph/plans/SPECIFICATION.md";
export const ACTIVE_EXECUTION_PLAN_PATH = ".ralph/plans/EXECUTION_PLAN.md";
export const BLOCKED_SPECIFICATION_PATH = ".ralph/plans/blocked/SPECIFICATION.md";
export const BLOCKED_EXECUTION_PLAN_PATH = ".ralph/plans/blocked/EXECUTION_PLAN.md";
export const ARCHIVE_ROOT_PATH = ".ralph/plans/archive";
export const BLOCKED_PROVENANCE_PATH = ".ralph/plans/blocked/.prime-ralph-lifecycle.json";
export const PLANNING_TRANSACTION_VERSION = 1;
export const MAX_TRANSACTION_DOCUMENT_BYTES = 1024 * 1024;
export const MAX_TRANSACTION_MARKER_BYTES = 64 * 1024;

const PAIRS = Object.freeze({
  active: Object.freeze([ACTIVE_SPECIFICATION_PATH, ACTIVE_EXECUTION_PLAN_PATH]),
  blocked: Object.freeze([BLOCKED_SPECIFICATION_PATH, BLOCKED_EXECUTION_PLAN_PATH]),
});

export class PlanningTransactionError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "PlanningTransactionError";
  }
}

function inspect(path, relativePath, lstat) {
  try { return lstat(path); }
  catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new PlanningTransactionError(`cannot inspect planning control path: ${relativePath}`, { cause: error });
  }
}

function assertParent(root, relativePath, lstat) {
  const parts = dirname(relativePath).split("/");
  let relative = "";
  for (const part of parts) {
    relative = relative ? `${relative}/${part}` : part;
    const stat = inspect(resolve(root, relative), relative, lstat);
    if (!stat) throw new PlanningTransactionError(`planning document parent is absent: ${relative}`);
    if (stat.isSymbolicLink()) throw new PlanningTransactionError(`planning document parent must not be a symlink: ${relative}`);
    if (!stat.isDirectory()) throw new PlanningTransactionError(`planning document parent is not a directory: ${relative}`);
  }
}

function inspectDocument(root, relativePath, lstat) {
  assertParent(root, relativePath, lstat);
  const stat = inspect(resolve(root, relativePath), relativePath, lstat);
  if (!stat) return undefined;
  if (stat.isSymbolicLink()) throw new PlanningTransactionError(`planning document must not be a symlink: ${relativePath}`);
  if (!stat.isFile()) throw new PlanningTransactionError(`planning document is not a regular file: ${relativePath}`);
  return stat;
}

function inspectPair(root, name, lstat, explicitPaths) {
  const paths = explicitPaths ?? PAIRS[name];
  const stats = paths.map((path) => inspectDocument(root, path, lstat));
  const present = stats.filter(Boolean).length;
  return { paths, stats, state: present === 0 ? "absent" : present === 2 ? "complete" : "partial" };
}
function inspectPairForRecovery(root, name, lstat) {
  try { return inspectPair(root, name, lstat); }
  catch (error) {
    if (!(error instanceof PlanningTransactionError) || !/parent is absent/.test(error.message)) throw error;
    return { paths: PAIRS[name], stats: PAIRS[name].map(() => undefined), state: "absent" };
  }
}

function documentEvidence(root, pair, readFile, maxBytes = MAX_TRANSACTION_DOCUMENT_BYTES) {
  return pair.paths.map((path, index) => {
    if (pair.stats[index].size > maxBytes) throw new PlanningTransactionError(`planning document exceeds ${maxBytes} bytes: ${path}`);
    let value;
    try { value = readFile(resolve(root, path)); }
    catch (error) { throw new PlanningTransactionError(`planning document is unreadable: ${path}`, { cause: error }); }
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (bytes.byteLength > maxBytes) throw new PlanningTransactionError(`planning document exceeds ${maxBytes} bytes: ${path}`);
    return { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
}

function requireComplete(pair, label) {
  if (pair.state !== "complete") {
    throw new PlanningTransactionError(`${label} planning document pair must be complete; found ${pair.state}`);
  }
}

function requireAbsent(pair, label) {
  if (pair.state !== "absent") {
    throw new PlanningTransactionError(`${label} planning document destination must be absent; found ${pair.state}`);
  }
}

/** Move a regular file without POSIX rename's destination-overwrite behavior. */
export function moveFileNoReplaceSync(source, destination, { link = linkSync, unlink = unlinkSync } = {}) {
  link(source, destination);
  try { unlink(source); }
  catch (error) {
    try { unlink(destination); }
    catch (rollbackError) {
      throw new PlanningTransactionError("failed to remove the source after linking and could not remove the destination", {
        cause: new AggregateError([error, rollbackError]),
      });
    }
    throw error;
  }
}

function requireArchiveName(archiveName) {
  if (typeof archiveName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(archiveName) || archiveName === "." || archiveName === "..") {
    throw new TypeError("archiveName must be one safe relative path segment");
  }
}

export function archivePlanningPaths(archiveName) {
  requireArchiveName(archiveName);
  const root = `${ARCHIVE_ROOT_PATH}/${archiveName}`;
  return Object.freeze({
    directory: root,
    documents: Object.freeze([`${root}/SPECIFICATION.md`, `${root}/EXECUTION_PLAN.md`]),
    provenance: `${root}/.prime-ralph-lifecycle.json`,
  });
}

function markerFor(operation, lifecycleId, source, destination, evidence, now) {
  return {
    source: "prime-ralph",
    protocolVersion: PLANNING_TRANSACTION_VERSION,
    transition: operation,
    lifecycleId,
    createdAt: new Date(now()).toISOString(),
    documents: source.paths.map((path, index) => ({ from: path, to: destination.paths[index], ...evidence[index] })),
  };
}

function readMarker(root, relativePath, { lstat, readFile }) {
  assertParent(root, relativePath, lstat);
  const absolute = resolve(root, relativePath);
  const stat = inspect(absolute, relativePath, lstat);
  if (!stat) throw new PlanningTransactionError(`blocked planning provenance is absent: ${relativePath}`);
  if (stat.isSymbolicLink()) throw new PlanningTransactionError(`planning provenance must not be a symlink: ${relativePath}`);
  if (!stat.isFile()) throw new PlanningTransactionError(`planning provenance is not a regular file: ${relativePath}`);
  if (stat.size > MAX_TRANSACTION_MARKER_BYTES) throw new PlanningTransactionError(`planning provenance exceeds ${MAX_TRANSACTION_MARKER_BYTES} bytes: ${relativePath}`);
  try { const value = readFile(absolute, "utf8"); if (Buffer.byteLength(value) > MAX_TRANSACTION_MARKER_BYTES) throw new PlanningTransactionError(`planning provenance exceeds ${MAX_TRANSACTION_MARKER_BYTES} bytes: ${relativePath}`); return JSON.parse(value); }
  catch (error) { throw new PlanningTransactionError(`planning provenance is invalid: ${relativePath}`, { cause: error }); }
}

function isBlockedMarker(marker) {
  const documents = marker?.documents;
  const pathsMatch = Array.isArray(documents) && documents.length === PAIRS.active.length && documents.every((document, index) =>
    document?.from === PAIRS.active[index] && document?.to === PAIRS.blocked[index] &&
    Number.isSafeInteger(document?.bytes) && document.bytes >= 0 && document.bytes <= MAX_TRANSACTION_DOCUMENT_BYTES &&
    typeof document?.sha256 === "string" && /^[a-f0-9]{64}$/.test(document.sha256));
  return marker?.source === "prime-ralph" && marker?.protocolVersion === PLANNING_TRANSACTION_VERSION &&
    marker?.transition === "block" && typeof marker?.lifecycleId === "string" && marker.lifecycleId.length > 0 &&
    !/[\r\n]/.test(marker.lifecycleId) && typeof marker?.createdAt === "string" &&
    !Number.isNaN(new Date(marker.createdAt).valueOf()) && pathsMatch;
}

function markerMatchesContents(root, pair, marker, readFile) {
  if (!isBlockedMarker(marker)) return false;
  const evidence = documentEvidence(root, pair, readFile);
  return evidence.every((item, index) => item.bytes === marker.documents[index].bytes && item.sha256 === marker.documents[index].sha256);
}

function validateBlockedMarker(marker, lifecycleId) {
  if (!isBlockedMarker(marker) || marker.lifecycleId !== lifecycleId) {
    throw new PlanningTransactionError("blocked planning provenance is stale or belongs to another lifecycle");
  }
}

/** Classify an exact blocked pair separately from legacy, partial, and stale state. */
export function inspectBlockedPlanningTransaction({ cwd = process.cwd(), lstat = lstatSync, readFile = readFileSync } = {}) {
  const root = resolve(cwd);
  const pair = inspectPair(root, "blocked", lstat);
  const markerPath = resolve(root, BLOCKED_PROVENANCE_PATH);
  const markerStat = inspect(markerPath, BLOCKED_PROVENANCE_PATH, lstat);
  if (!markerStat) return Object.freeze({ state: pair.state === "complete" ? "unproven" : pair.state, paths: [...pair.paths] });
  if (markerStat.isSymbolicLink()) throw new PlanningTransactionError(`planning provenance must not be a symlink: ${BLOCKED_PROVENANCE_PATH}`);
  if (!markerStat.isFile()) throw new PlanningTransactionError(`planning provenance is not a regular file: ${BLOCKED_PROVENANCE_PATH}`);
  if (markerStat.size > MAX_TRANSACTION_MARKER_BYTES) return Object.freeze({ state: "stale", paths: [...pair.paths] });
  let provenance;
  try { const value = readFile(markerPath, "utf8"); if (Buffer.byteLength(value) > MAX_TRANSACTION_MARKER_BYTES) return Object.freeze({ state: "stale", paths: [...pair.paths] }); provenance = JSON.parse(value); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw new PlanningTransactionError(`planning provenance is unreadable: ${BLOCKED_PROVENANCE_PATH}`, { cause: error });
    return Object.freeze({ state: "stale", paths: [...pair.paths] });
  }
  if (pair.state !== "complete" || !isBlockedMarker(provenance)) return Object.freeze({ state: pair.state === "partial" ? "partial" : "stale", paths: [...pair.paths] });
  try {
    if (!markerMatchesContents(root, pair, provenance, readFile)) return Object.freeze({ state: "stale", paths: [...pair.paths] });
  } catch (error) {
    if (error instanceof PlanningTransactionError && /exceeds/.test(error.message)) return Object.freeze({ state: "stale", paths: [...pair.paths] });
    throw error;
  }
  return Object.freeze({ state: "complete", paths: [...pair.paths], lifecycleId: provenance.lifecycleId, provenance: Object.freeze(provenance) });
}


/** Verify exact active files against one valid saved blocked-work record without changing the filesystem. */
export function inspectRestoredPlanningEvidence({ cwd = process.cwd(), provenance, lstat = lstatSync, readFile = readFileSync } = {}) {
  const root = resolve(cwd);
  const active = inspectPairForRecovery(root, "active", lstat);
  const blocked = inspectPairForRecovery(root, "blocked", lstat);
  if (blocked.state !== "absent") return Object.freeze({ state: "conflict", paths: [...active.paths], blockedPaths: [...blocked.paths] });
  if (!isBlockedMarker(provenance)) return Object.freeze({ state: "stale", paths: [...active.paths] });
  if (active.state !== "complete") return Object.freeze({ state: active.state, paths: [...active.paths], lifecycleId: provenance.lifecycleId, provenance: Object.freeze(provenance) });
  try {
    if (!markerMatchesContents(root, active, provenance, readFile)) return Object.freeze({ state: "modified", paths: [...active.paths], lifecycleId: provenance.lifecycleId, provenance: Object.freeze(provenance) });
  } catch (error) {
    if (error instanceof PlanningTransactionError && /exceeds/.test(error.message)) return Object.freeze({ state: "modified", paths: [...active.paths], lifecycleId: provenance.lifecycleId, provenance: Object.freeze(provenance) });
    throw error;
  }
  return Object.freeze({ state: "complete", paths: [...active.paths], lifecycleId: provenance.lifecycleId, provenance: Object.freeze(provenance) });
}

/** Classify a blocked pair that was moved back to the exact active paths outside the control transaction. */
export function inspectRestoredPlanningTransaction({ cwd = process.cwd(), lstat = lstatSync, readFile = readFileSync } = {}) {
  const root = resolve(cwd);
  const active = inspectPairForRecovery(root, "active", lstat);
  const blocked = inspectPairForRecovery(root, "blocked", lstat);
  if (blocked.state !== "absent") return Object.freeze({ state: "conflict", paths: [...active.paths], blockedPaths: [...blocked.paths] });
  const markerPath = resolve(root, BLOCKED_PROVENANCE_PATH);
  const markerStat = inspect(markerPath, BLOCKED_PROVENANCE_PATH, lstat);
  if (!markerStat) return Object.freeze({ state: active.state === "absent" ? "absent" : "unproven", paths: [...active.paths] });
  if (markerStat.isSymbolicLink()) throw new PlanningTransactionError(`saved blocked-work record must not be a symlink: ${BLOCKED_PROVENANCE_PATH}`);
  if (!markerStat.isFile()) throw new PlanningTransactionError(`saved blocked-work record is not a regular file: ${BLOCKED_PROVENANCE_PATH}`);
  if (markerStat.size > MAX_TRANSACTION_MARKER_BYTES) return Object.freeze({ state: "stale", paths: [...active.paths] });
  let provenance;
  try { const value = readFile(markerPath, "utf8"); if (Buffer.byteLength(value) > MAX_TRANSACTION_MARKER_BYTES) return Object.freeze({ state: "stale", paths: [...active.paths] }); provenance = JSON.parse(value); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw new PlanningTransactionError(`saved blocked-work record is unreadable: ${BLOCKED_PROVENANCE_PATH}`, { cause: error });
    return Object.freeze({ state: "stale", paths: [...active.paths] });
  }
  return inspectRestoredPlanningEvidence({ cwd, provenance, lstat, readFile });
}

function restoredFailure(state) {
  const reasons = {
    absent: "the exact active planning document pair is absent",
    partial: "the active planning document pair is partial; restore both exact files",
    unproven: "the saved blocked-work record is absent",
    stale: "the saved blocked-work record is invalid",
    modified: "the restored active planning documents do not match the saved blocked-work record",
    conflict: "blocked planning documents still exist and conflict with the active pair",
  };
  return reasons[state] ?? `their state is ${state}`;
}

/** Accept an exact manually restored pair and remove only its verified saved blocked-work marker. */
export function adoptRestoredPlanningDocuments({ cwd = process.cwd(), lifecycleId, lstat = lstatSync, readFile = readFileSync, unlink = unlinkSync } = {}) {
  requireLifecycleId(lifecycleId);
  const inspected = inspectRestoredPlanningTransaction({ cwd, lstat, readFile });
  if (inspected.state !== "complete") throw new PlanningTransactionError(`cannot accept the restored planning documents because ${restoredFailure(inspected.state)}`);
  if (inspected.lifecycleId !== lifecycleId) throw new PlanningTransactionError("the saved blocked-work record belongs to a different Ralph execution");
  try { unlink(resolve(cwd, BLOCKED_PROVENANCE_PATH)); }
  catch (error) { throw new PlanningTransactionError(`verified the restored planning documents but could not remove the saved blocked-work record: ${BLOCKED_PROVENANCE_PATH}`, { cause: error }); }
  return Object.freeze({ operation: "adopt-restored", lifecycleId, paths: [...inspected.paths], removedRecord: BLOCKED_PROVENANCE_PATH, provenance: inspected.provenance });
}

/** Finish an interrupted adoption after the marker was removed but before durable state was finalized. */
export function verifyAdoptedPlanningDocuments({ cwd = process.cwd(), lifecycleId, provenance, lstat = lstatSync, readFile = readFileSync } = {}) {
  requireLifecycleId(lifecycleId);
  if (!isBlockedMarker(provenance) || provenance.lifecycleId !== lifecycleId) throw new PlanningTransactionError("the saved adoption intent is invalid or belongs to different blocked work");
  const inspected = inspectRestoredPlanningEvidence({ cwd, provenance, lstat, readFile });
  if (inspected.state !== "complete") throw new PlanningTransactionError(`cannot finish the restored planning recovery because ${restoredFailure(inspected.state)}`);
  return Object.freeze({ operation: "verify-adopted", lifecycleId, paths: [...inspected.paths] });
}

function rollbackMoves(completed, move, operationError) {
  const rollbackErrors = [];
  for (const { source, destination } of [...completed].reverse()) {
    try { move(destination, source); }
    catch (error) { rollbackErrors.push(error); }
  }
  if (rollbackErrors.length) {
    throw new PlanningTransactionError("planning transaction failed and rollback was incomplete", {
      cause: new AggregateError([operationError, ...rollbackErrors]),
    });
  }
  throw new PlanningTransactionError("planning transaction failed; all completed moves were rolled back", { cause: operationError });
}

function runMoves(root, source, destination, move) {
  const completed = [];
  try {
    for (let index = 0; index < source.paths.length; index += 1) {
      const item = { source: resolve(root, source.paths[index]), destination: resolve(root, destination.paths[index]) };
      move(item.source, item.destination);
      completed.push(item);
    }
  } catch (error) { rollbackMoves(completed, move, error); }
  return completed;
}

function requireLifecycleId(lifecycleId) {
  if (typeof lifecycleId !== "string" || !lifecycleId || /[\r\n]/.test(lifecycleId)) {
    throw new TypeError("lifecycleId must be a non-empty single-line string");
  }
}

/**
 * Move the exact specification/plan pair as one recoverable transaction.
 * `operation` is `block`, `unblock`, or `archive`; destinations are never overwritten.
 */
export function transactPlanningDocuments({
  cwd = process.cwd(), operation, lifecycleId, archiveName, now = Date.now,
  lstat = lstatSync, readFile = readFileSync, writeFile = writeFileSync,
  mkdir = mkdirSync, rmdir = rmdirSync, unlink = unlinkSync, move = moveFileNoReplaceSync,
} = {}) {
  requireLifecycleId(lifecycleId);
  if (!new Set(["block", "unblock", "archive"]).has(operation)) throw new TypeError(`unknown planning transaction operation: ${operation}`);
  const root = resolve(cwd);
  const sourceName = operation === "unblock" ? "blocked" : "active";
  const destinationName = operation === "block" ? "blocked" : operation === "unblock" ? "active" : "archive";
  const source = inspectPair(root, sourceName, lstat);
  requireComplete(source, sourceName);
  const sourceEvidence = documentEvidence(root, source, readFile);

  let archive;
  let createdArchiveDirectory = false;
  let destination;
  try {
    if (operation === "archive") {
      archive = archivePlanningPaths(archiveName);
      assertParent(root, `${ARCHIVE_ROOT_PATH}/placeholder`, lstat);
      const archiveDirectoryStat = inspect(resolve(root, archive.directory), archive.directory, lstat);
      if (archiveDirectoryStat) throw new PlanningTransactionError(`archive destination already exists: ${archive.directory}`);
      try { mkdir(resolve(root, archive.directory), { mode: 0o700 }); }
      catch (error) { throw new PlanningTransactionError(`cannot create archive destination: ${archive.directory}`, { cause: error }); }
      createdArchiveDirectory = true;
      const created = inspect(resolve(root, archive.directory), archive.directory, lstat);
      if (!created?.isDirectory() || created.isSymbolicLink()) throw new PlanningTransactionError(`created archive destination is not a real directory: ${archive.directory}`);
      destination = inspectPair(root, destinationName, lstat, archive.documents);
    } else destination = inspectPair(root, destinationName, lstat);
    requireAbsent(destination, destinationName);

    let marker;
    if (operation === "unblock") {
      marker = readMarker(root, BLOCKED_PROVENANCE_PATH, { lstat, readFile });
      validateBlockedMarker(marker, lifecycleId);
      if (!sourceEvidence.every((item, index) => item.bytes === marker.documents[index].bytes && item.sha256 === marker.documents[index].sha256)) {
        throw new PlanningTransactionError("blocked planning contents do not match lifecycle provenance");
      }
    } else {
      const markerPath = operation === "block" ? BLOCKED_PROVENANCE_PATH : archive.provenance;
      const markerStat = inspect(resolve(root, markerPath), markerPath, lstat);
      if (markerStat) throw new PlanningTransactionError(`planning provenance destination must be absent: ${markerPath}`);
      marker = markerFor(operation, lifecycleId, source, destination, sourceEvidence, now);
    }

    const completed = runMoves(root, source, destination, move);
    const markerPath = operation === "archive" ? archive.provenance : BLOCKED_PROVENANCE_PATH;
    try {
      const movedPair = inspectPair(root, destinationName, lstat, operation === "archive" ? archive.documents : undefined);
      requireComplete(movedPair, destinationName);
      const movedEvidence = documentEvidence(root, movedPair, readFile);
      if (!movedEvidence.every((item, index) => item.bytes === sourceEvidence[index].bytes && item.sha256 === sourceEvidence[index].sha256)) {
        throw new PlanningTransactionError("planning document contents changed during transaction");
      }
      if (operation === "unblock") unlink(resolve(root, markerPath));
      else writeFile(resolve(root, markerPath), `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) { rollbackMoves(completed, move, error); }

    return Object.freeze({ operation, lifecycleId, archiveName: operation === "archive" ? archiveName : undefined, from: [...source.paths], to: [...destination.paths], provenancePath: operation === "unblock" ? undefined : markerPath });
  } catch (error) {
    if (createdArchiveDirectory) {
      try { rmdir(resolve(root, archive.directory)); }
      catch (cleanupError) {
        throw new PlanningTransactionError("archive transaction failed and its new destination directory could not be removed", { cause: new AggregateError([error, cleanupError]) });
      }
    }
    throw error;
  }
}

export function blockPlanningDocuments(options) { return transactPlanningDocuments({ ...options, operation: "block" }); }
export function unblockPlanningDocuments(options) { return transactPlanningDocuments({ ...options, operation: "unblock" }); }
export function archivePlanningDocuments(options) { return transactPlanningDocuments({ ...options, operation: "archive" }); }
