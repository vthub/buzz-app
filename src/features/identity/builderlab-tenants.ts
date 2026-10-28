import type { FoundCommunity } from "../communities/find-community.ts";

/**
 * One Builderlab deployment: the relays it hosts and where its people sign in.
 * Public configuration from the `BUZZ_BUILDERLAB_TENANTS` build input, which
 * also feeds the bundled plugin's native network grant (plugin-manager build.rs
 * applies the same row rules), so the table can only ever name origins the
 * native host lets the first-run OAuth client reach.
 */
export type BuilderlabTenant = Readonly<{
  /** Lowercase relay hostname: matched exactly or as a suffix at a label boundary. */
  relayHost: string;
  /** The deployment's relay key (NIP-11 `self`), 64 lowercase hex; survives DNS moves. */
  self?: string | undefined;
  /** Canonical https origin of the tenant's portal, as `new URL(x).origin` prints it. */
  loginOrigin: string;
}>;

export type Authentication =
  | { kind: "builderlab"; origin: string }
  | { kind: "none" };

const HOSTNAME =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** The shape relay/native.ts requires of NIP-11 `self`. */
const RELAY_KEY = /^[a-f0-9]{64}$/;

export function parseBuilderlabTenants(raw = ""): readonly BuilderlabTenant[] {
  if (!raw.trim()) return [];
  try {
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows)) throw new Error();
    const hosts = new Set<string>();
    const keys = new Set<string>();
    const tenants = rows.map((row: unknown): BuilderlabTenant => {
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw new Error();
      const { relayHost, self, loginOrigin, ...rest } = row as Record<
        string,
        unknown
      >;
      if (
        Object.keys(rest).length > 0 ||
        typeof relayHost !== "string" ||
        typeof loginOrigin !== "string" ||
        (self !== undefined && typeof self !== "string")
      )
        throw new Error();
      // ASCII-only folding and the 253-byte cap mirror build.rs, so a row the
      // native grant would refuse fails here, at configuration time, instead.
      const host = relayHost
        .trim()
        .replace(/[A-Z]/g, (c) => c.toLowerCase())
        .replace(/\.$/, "");
      const origin = new URL(loginOrigin);
      if (
        !HOSTNAME.test(host) ||
        host.length > 253 ||
        hosts.has(host) ||
        origin.protocol !== "https:" ||
        origin.username ||
        origin.password ||
        origin.origin !== loginOrigin ||
        (self !== undefined && (!RELAY_KEY.test(self) || keys.has(self)))
      )
        throw new Error();
      hosts.add(host);
      if (self !== undefined) keys.add(self);
      return Object.freeze({ relayHost: host, self, loginOrigin });
    });
    // Longest suffix first, so a nested row (`buzz.x.example` beside `example`) wins.
    return Object.freeze(
      tenants.sort((a, b) => b.relayHost.length - a.relayHost.length),
    );
  } catch {
    // Do not echo malformed input: an environment value might contain credentials.
    throw new Error(
      "BUZZ_BUILDERLAB_TENANTS must be a JSON array of {relayHost, self?, loginOrigin} rows with unique hostnames, unique 64-hex relay keys and canonical https login origins.",
    );
  }
}

export const configuredBuilderlabTenants = parseBuilderlabTenants(
  import.meta.env?.VITE_BUZZ_BUILDERLAB_TENANTS,
);

/**
 * Which sign-in a community URL given before setup leads to.
 *
 * Hostname first (exact or label-boundary suffix: `design.communities.buzz.xyz`
 * and the apex match `communities.buzz.xyz`; `notcommunities.buzz.xyz` and
 * `communities.buzz.xyz.evil.com` do not), then the relay's NIP-11 `self`, which
 * keeps a known deployment recognisable while its DNS is reshuffled and can
 * only select an origin already in the table. Block's deployments serve on 443,
 * so a non-default port never matches. Anything else is `none`: a host Block
 * does not list is not known to be Builderlab-hosted, so no portal is chosen
 * for it; the welcome screen instead asks whether to connect at the build
 * portal (a key linked to that account and backed up there, which the relay
 * itself cannot use) or to bring an existing key.
 *
 * Precedence if a relay ever publishes an identity-provider hint in NIP-11: the
 * table wins outright (a relay cannot redirect a known host); with no table
 * match, accept a `builderlab` hint only for a `loginOrigin` already in the
 * table, since only those are in the native grant; otherwise `none`. Not parsed
 * today — nothing a relay publishes names its identity provider.
 */
export function discoverAuthentication(
  found: FoundCommunity,
  tenants: readonly BuilderlabTenant[] = configuredBuilderlabTenants,
): Authentication {
  // Canonical already: relayOrigin() lower-cased the host and dropped a final dot.
  const url = new URL(found.url);
  if (url.port !== "") return { kind: "none" };
  const host = url.hostname;
  const match =
    tenants.find(
      (tenant) =>
        host === tenant.relayHost || host.endsWith(`.${tenant.relayHost}`),
    ) ??
    (found.self === undefined
      ? undefined
      : tenants.find((tenant) => tenant.self === found.self));
  return match
    ? { kind: "builderlab", origin: match.loginOrigin }
    : { kind: "none" };
}
