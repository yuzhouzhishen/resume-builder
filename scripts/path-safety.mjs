import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export function canonicalizePath(candidate) {
  let existingAncestor = path.resolve(candidate);
  const missingSegments = [];

  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      break;
    }
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }

  return path.resolve(realpathSync(existingAncestor), ...missingSegments);
}

export function isSameOrNestedPath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function resolvePathInside(baseDir, requestedPath, label = "Path") {
  const resolvedBase = path.resolve(baseDir);
  const resolvedPath = path.resolve(resolvedBase, requestedPath);
  if (!isSameOrNestedPath(resolvedBase, resolvedPath) || resolvedPath === resolvedBase) {
    throw new Error(`${label} must stay inside the resume data root: ${requestedPath}`);
  }

  const canonicalBase = canonicalizePath(resolvedBase);
  const canonicalPath = canonicalizePath(resolvedPath);
  if (!isSameOrNestedPath(canonicalBase, canonicalPath) || canonicalPath === canonicalBase) {
    throw new Error(`${label} must stay inside the resume data root: ${requestedPath}`);
  }

  return resolvedPath;
}
