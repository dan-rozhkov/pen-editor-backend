import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createByokFetch, createGuardedLookup, isPublicAddress, parseByokBaseUrl } from "../src/ai/byokNetwork.js";

const STRICT = { allowPrivateNetwork: false };
const LOOSE = { allowPrivateNetwork: true };

describe("parseByokBaseUrl", () => {
  it.each([
    ["https://api.openai.com/v1", "https://api.openai.com/v1"],
    ["  https://api.groq.com/openai/v1/  ", "https://api.groq.com/openai/v1"],
    ["https://example.com", "https://example.com"],
    ["https://8.8.8.8/v1", "https://8.8.8.8/v1"],
  ])("accepts %s", (raw, url) => {
    expect(parseByokBaseUrl(raw, STRICT)).toEqual({ ok: true, url });
  });

  it.each([
    "",
    "not a url",
    "http://api.openai.com/v1",
    "ftp://example.com",
    "https://user:pass@example.com/v1",
    "https://example.com/v1?x=1",
    "https://example.com/v1#frag",
    "https://localhost/v1",
    "https://foo.localhost/v1",
    "https://printer.local/v1",
    "https://db.internal/v1",
    "https://127.0.0.1/v1",
    "https://2130706433/v1",
    "https://0x7f.1/v1",
    "https://10.0.0.5/v1",
    "https://100.64.0.1/v1",
    "https://169.254.169.254/latest",
    "https://172.16.0.1/v1",
    "https://192.168.1.1/v1",
    "https://0.0.0.0/v1",
    "https://224.0.0.1/v1",
    "https://[::1]/v1",
    "https://[::]/v1",
    "https://[fc00::1]/v1",
    "https://[fe80::1]/v1",
    "https://[::ffff:127.0.0.1]/v1",
    "https://[::ffff:10.0.0.1]/v1",
  ])("rejects %s", (raw) => {
    expect(parseByokBaseUrl(raw, STRICT)).toEqual({ ok: false });
  });

  it.each([
    ["http://localhost:11434/v1", "http://localhost:11434/v1"],
    ["http://127.0.0.1:1234/v1", "http://127.0.0.1:1234/v1"],
    ["https://db.internal/v1", "https://db.internal/v1"],
  ])("allows %s when private network is allowed", (raw, url) => {
    expect(parseByokBaseUrl(raw, LOOSE)).toEqual({ ok: true, url });
  });

  it("still rejects credentials, query and non-http(s) when private network is allowed", () => {
    expect(parseByokBaseUrl("http://u:p@localhost/v1", LOOSE)).toEqual({ ok: false });
    expect(parseByokBaseUrl("http://localhost/v1?a=1", LOOSE)).toEqual({ ok: false });
    expect(parseByokBaseUrl("ftp://localhost/v1", LOOSE)).toEqual({ ok: false });
  });
});

describe("isPublicAddress", () => {
  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8", "[2606:4700:4700::1111]"])(
    "%s is public",
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true);
    },
  );

  it.each([
    "0.0.0.1",
    "10.1.2.3",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a00:1",
    "::7f00:1",
    "::a00:1",
    "2002:7f00:1::1",
    "2002:a9fe:a9fe::1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b:1::1",
    "2001::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "100::1",
    "2001:db8::1",
    "not-an-ip",
    "",
  ])("%s is not public", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});

type Resolved = Array<{ address: string; family: number }>;
const lookupVia = (strict: boolean, addresses: Resolved) =>
  new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((resolve) => {
    const guarded = createGuardedLookup(
      { allowPrivateNetwork: !strict },
      (_host, _opts, cb) => cb(null, addresses),
    );
    guarded("rebind.example", { all: true }, (err, address) => resolve({ err, address }));
  });

describe("createGuardedLookup (DNS rebinding guard)", () => {
  it("refuses a host that resolves to loopback", async () => {
    const { err } = await lookupVia(true, [{ address: "127.0.0.1", family: 4 }]);
    expect(err?.code).toBe("EBYOKPRIVATE");
  });

  it("refuses when any one of several answers is private", async () => {
    const { err } = await lookupVia(true, [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    expect(err?.code).toBe("EBYOKPRIVATE");
  });

  it("passes public answers through", async () => {
    const { err, address } = await lookupVia(true, [{ address: "8.8.8.8", family: 4 }]);
    expect(err).toBeNull();
    expect(address).toEqual([{ address: "8.8.8.8", family: 4 }]);
  });

  it("allows private answers when private network is allowed", async () => {
    const { err } = await lookupVia(false, [{ address: "127.0.0.1", family: 4 }]);
    expect(err).toBeNull();
  });
});

describe("createByokFetch (local server on 127.0.0.1)", () => {
  let server: Server;
  let origin: string;
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/target" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects a literal loopback IP when private network is not allowed", async () => {
    const before = hits.length;
    await expect(createByokFetch(STRICT)(`${origin}/ok`)).rejects.toThrow();
    expect(hits.length).toBe(before);
  });

  it("reaches the server when private network is allowed", async () => {
    const res = await createByokFetch(LOOSE)(`${origin}/ok`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("does not follow a redirect", async () => {
    hits.length = 0;
    await expect(createByokFetch(LOOSE)(`${origin}/redirect`)).rejects.toThrow(/redirect/);
    expect(hits).toEqual(["/redirect"]);
  });
});
