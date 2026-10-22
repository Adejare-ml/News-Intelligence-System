/**
 * The real TLS socket, from the Workers runtime. Loaded only when Gmail
 * actually sends, so unit tests (which run in Node) never import it.
 */
import { connect } from "cloudflare:sockets";
import type { SmtpSocket } from "./smtp.ts";

export async function openTls(hostname: string, port: number): Promise<SmtpSocket> {
  const socket = connect({ hostname, port }, { secureTransport: "on" });
  await socket.opened;
  return socket;
}
