/** Test helper (not shipped: the build drops *.test.* files). */
import type { OpenSocket } from "./smtp.ts";

/** An in-memory SMTP server speaking just enough of Gmail's dialect. */
export function fakeSmtp(opts: { password?: string; reject?: string[] } = {}) {
  const transcript: string[] = [];
  const delivered: { from: string; to: string; data: string }[] = [];
  const open: OpenSocket = async () => {
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    const toServer = new TransformStream<Uint8Array, Uint8Array>();
    const out = toClient.writable.getWriter();
    const say = (line: string) => out.write(new TextEncoder().encode(`${line}\r\n`));
    (async () => {
      const reader = toServer.readable.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let state: "cmd" | "user" | "pass" | "data" = "cmd";
      let from = "";
      let to = "";
      let rcptOk = false;
      let data: string[] = [];
      await say("220 smtp.fake ESMTP");
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\r\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          if (state === "data") {
            if (line === ".") {
              delivered.push({ from, to, data: data.join("\r\n") });
              data = [];
              state = "cmd";
              await say("250 2.0.0 OK queued");
            } else data.push(line.startsWith("..") ? line.slice(1) : line);
            continue;
          }
          transcript.push(state === "pass" ? "<password>" : line);
          if (state === "user") {
            state = "pass";
            await say("334 UGFzc3dvcmQ6");
          } else if (state === "pass") {
            state = "cmd";
            const ok = atob(line) === (opts.password ?? "app-password");
            await say(ok ? "235 2.7.0 Accepted" : "535 5.7.8 Username and Password not accepted");
          } else if (line.startsWith("EHLO")) {
            await say("250-smtp.fake at your service");
            await say("250-PIPELINING");
            await say("250 AUTH LOGIN PLAIN");
          } else if (line === "AUTH LOGIN") {
            state = "user";
            await say("334 VXNlcm5hbWU6");
          } else if (line.startsWith("MAIL FROM:")) {
            from = line.slice(11, -1);
            await say("250 2.1.0 OK");
          } else if (line.startsWith("RCPT TO:")) {
            to = line.slice(9, -1);
            rcptOk = !(opts.reject ?? []).includes(to);
            await say(rcptOk ? "250 2.1.5 OK" : "550 5.1.1 No such user");
          } else if (line === "DATA") {
            if (rcptOk) {
              state = "data";
              await say("354 Go ahead");
            } else await say("554 5.5.1 No valid recipients");
          } else if (line === "RSET") {
            await say("250 2.1.5 Flushed");
          } else if (line === "QUIT") {
            await say("221 2.0.0 closing");
            await out.close();
            return;
          } else await say("502 5.5.1 Unrecognized command");
        }
      }
    })();
    return { readable: toClient.readable, writable: toServer.writable, close: async () => undefined };
  };
  return { open, transcript, delivered };
}

