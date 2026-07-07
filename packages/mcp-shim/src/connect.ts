/**
 * Parse the broker connect target from the shim argv (§3.1): a unix socket path
 * (`--socket <path>`, the Linux default) or a TCP endpoint (`--tcp <host:port>`,
 * for macOS Docker Desktop, where a bind-mounted socket is unconnectable across
 * the host↔VM boundary). Pure + exported so it can be unit-tested without the
 * shim's stdio loop.
 */
export function brokerConnectArg(argv: string[]): { path: string } | { host: string; port: number } {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i >= 0 && argv[i + 1]) return argv[i + 1];
    return argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
  };
  const tcp = flag("--tcp");
  if (tcp) {
    const idx = tcp.lastIndexOf(":");
    const host = tcp.slice(0, idx);
    const port = Number(tcp.slice(idx + 1));
    if (!host || !Number.isInteger(port)) throw new Error(`marathon-mcp-shim: bad --tcp "${tcp}" (want host:port)`);
    return { host, port };
  }
  const socket = flag("--socket");
  if (socket) return { path: socket };
  throw new Error("marathon-mcp-shim: --socket <path> or --tcp <host:port> is required");
}
