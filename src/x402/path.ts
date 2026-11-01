// Path canonicalization shared by every transport.

/**
 * Lower-case, percent-decoded, dot-segment-resolved path with single slashes and no trailing slash.
 * Returns null when the path holds an escape that does not decode.
 */
export function canonicalPath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const segments: string[] = [];
  for (const segment of decoded.replace(/\\/g, "/").toLowerCase().split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}
