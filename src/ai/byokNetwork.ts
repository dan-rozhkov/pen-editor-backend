// Network guard for the BYOK custom provider (see
// docs/specs/2026-11-13-byok-custom-provider-design.md, "SSRF").
//
// The Base URL comes from the client and OUR server makes the request, so two
// layers apply: parseByokBaseUrl (synchronous, literal hosts) and the
// connect-time DNS lookup guard plus a post-connect peer-address check in
// createByokFetch (closes DNS rebinding and literal-IP hosts), and redirects
// are never followed.

import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";

export interface ByokNetworkOptions {
  allowPrivateNetwork: boolean;
}

const BLOCKED = new BlockList();
const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
for (const [net, prefix] of V4_BLOCKED) BLOCKED.addSubnet(net, prefix, "ipv4");
const V6_BLOCKED: Array<[string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["::", 96], // IPv4-compatible (deprecated); also covers :: and ::1
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
];
for (const [net, prefix] of V6_BLOCKED) BLOCKED.addSubnet(net, prefix, "ipv6");

// "::ffff:a.b.c.d" and "::ffff:abcd:ef01" -> the embedded IPv4, else undefined.
function mappedV4(ip: string): string | undefined {
  const lower = ip.toLowerCase();
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return undefined;
}

/** True only for a syntactically valid IP that is publicly routable. */
export function isPublicAddress(ip: string): boolean {
  const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const family = isIP(bare);
  if (family === 0) return false;
  if (family === 6) {
    const v4 = mappedV4(bare);
    if (v4) return isPublicAddress(v4);
    return !BLOCKED.check(bare, "ipv6");
  }
  return !BLOCKED.check(bare, "ipv4");
}

function isLocalHostname(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  );
}

export type ParsedByokBaseUrl = { ok: true; url: string } | { ok: false };

export function parseByokBaseUrl(raw: string, opts: ByokNetworkOptions): ParsedByokBaseUrl {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false };
  }
  const protocolOk = url.protocol === "https:" || (opts.allowPrivateNetwork && url.protocol === "http:");
  if (!protocolOk) return { ok: false };
  if (url.username || url.password) return { ok: false };
  if (url.search || url.hash) return { ok: false };
  if (!url.hostname) return { ok: false };
  if (!opts.allowPrivateNetwork) {
    // WHATWG URL already normalised octal/hex/decimal IPv4 forms to dotted
    // quad and wrapped IPv6 in brackets.
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const bare = host.startsWith("[") ? host.slice(1, -1) : host;
    if (isLocalHostname(host)) return { ok: false };
    if (isIP(bare) !== 0 && !isPublicAddress(bare)) return { ok: false };
  }
  return { ok: true, url: url.toString().replace(/\/+$/, "") };
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

type LookupFn = (
  hostname: string,
  options: { all?: boolean; family?: number; hints?: number },
  callback: LookupCallback,
) => void;

/**
 * Connect-time DNS lookup that refuses non-public answers. Exported so the
 * guard can be tested without a network; `resolve` is a test seam.
 */
export function createGuardedLookup(
  opts: ByokNetworkOptions,
  resolve: LookupFn = dnsLookup as unknown as LookupFn,
): LookupFn {
  return (hostname, options, callback) => {
    // Always resolve every address so one public record cannot hide a private one.
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "");
      const list = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0) {
        return callback(Object.assign(new Error(`BYOK host ${hostname} did not resolve`), { code: "ENOTFOUND" }), "");
      }
      if (!opts.allowPrivateNetwork && list.some((a) => !isPublicAddress(a.address))) {
        return callback(
          Object.assign(new Error(`BYOK host ${hostname} resolves to a non-public address`), { code: "EBYOKPRIVATE" }),
          "",
        );
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

const agents = new Map<boolean, Agent>();

type ConnectOptions = Parameters<ReturnType<typeof buildConnector>>[0];
type ConnectCallback = Parameters<ReturnType<typeof buildConnector>>[1];

/**
 * undici connector that, after the socket is up, checks the peer address.
 * Node skips `lookup` for literal-IP hosts, so this is the layer that covers
 * them (and is a second check for resolved hosts).
 */
function guardedConnector(opts: ByokNetworkOptions) {
  const inner = buildConnector({ lookup: createGuardedLookup(opts) as never });
  return (connectOptions: ConnectOptions, callback: ConnectCallback) => {
    inner(connectOptions, (err, socket) => {
      if (err || !socket) return callback(err, null);
      const remote = socket.remoteAddress;
      if (!opts.allowPrivateNetwork && !(remote && isPublicAddress(remote))) {
        socket.destroy();
        return callback(
          Object.assign(new Error("BYOK connection to a non-public address refused"), { code: "EBYOKPRIVATE" }),
          null,
        );
      }
      return callback(null, socket);
    });
  };
}

function agentFor(opts: ByokNetworkOptions): Agent {
  let agent = agents.get(opts.allowPrivateNetwork);
  if (!agent) {
    agent = new Agent({ connect: guardedConnector(opts) as never });
    agents.set(opts.allowPrivateNetwork, agent);
  }
  return agent;
}

/**
 * A fetch whose every connection goes through the guarded connector.
 * Redirects are never followed: API endpoints do not need them, and a public
 * host could otherwise bounce the request to an internal address. Any 3xx
 * response is turned into an error.
 */
export function createByokFetch(opts: ByokNetworkOptions): typeof fetch {
  const dispatcher = agentFor(opts);
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const res = await undiciFetch(input as never, {
      ...(init as object),
      dispatcher,
      redirect: "manual",
    } as never);
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`BYOK endpoint answered with a redirect (HTTP ${res.status}), which is not followed`);
    }
    return res;
  }) as unknown as typeof fetch;
}
