import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMTPServer } from "smtp-server";

/**
 * A real, in-process SMTP server for the email tests.
 *
 * The SMTP transport is exercised against an actual TLS SMTP conversation —
 * not a stub of `nodemailer` — so a regression in the connection, the STARTTLS
 * upgrade, the authentication or the envelope handling is caught here.
 *
 * The TLS key/cert is generated at runtime with `openssl` into a temp directory
 * and deleted afterwards: **no private key is ever committed to the repository**.
 * The client trusts it through the base64 `SMTP_TLS_CA` variable, which is the
 * same code path a self-hosted operator would use for a private CA.
 */

export type ReceivedMessage = {
  from: string;
  to: string[];
  /** The full RFC 822 message, so a test can find the verification link. */
  raw: string;
};

export type TestSmtpServer = {
  port: number;
  /** Base64 PEM of the server certificate, for `SMTP_TLS_CA`. */
  certBase64: string;
  received: ReceivedMessage[];
  /** The plaintext body of the most recent message (after the blank line). */
  lastText(): string;
  close(): Promise<void>;
};

export type TestSmtpOptions = {
  /** Credentials the server accepts. Defaults to `user` / `pass`. */
  user?: string;
  pass?: string;
  /** Reject every recipient with a 550, to model an envelope rejection. */
  rejectRecipients?: boolean;
};

/**
 * Decode quoted-printable body text. nodemailer encodes `=` as `=3D` and wraps
 * long lines with a trailing `=`, so a raw substring check on a URL would miss.
 */
function decodeQuotedPrintable(input: string): string {
  const softJoined = input.replace(/=\r\n/g, "").replace(/=\n/g, "");
  return softJoined
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\r\n/g, "\n");
}

function generateCert(): { key: string; cert: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "intent-pay-smtp-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "3650",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8"), dir };
}

/** Start a TLS SMTP server on an ephemeral localhost port. */
export async function startTestSmtpServer(options: TestSmtpOptions = {}): Promise<TestSmtpServer> {
  const user = options.user ?? "user@example.com";
  const pass = options.pass ?? "app-password";
  const { key, cert, dir } = generateCert();
  const received: ReceivedMessage[] = [];

  const server = new SMTPServer({
    secure: false, // STARTTLS, like a real submission port
    authOptional: false,
    key,
    cert,
    onAuth(auth, _session, cb) {
      if (auth.username === user && auth.password === pass) {
        cb(null, { user: auth.username });
        return;
      }
      const err = Object.assign(new Error("Invalid login"), { responseCode: 535 });
      cb(err);
    },
    onRcptTo(_address, _session, cb) {
      if (options.rejectRecipients) {
        cb(Object.assign(new Error("No such recipient"), { responseCode: 550 }));
        return;
      }
      cb();
    },
    onData(stream, session, cb) {
      let raw = "";
      stream.on("data", (chunk) => {
        raw += chunk;
      });
      stream.on("end", () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          to: session.envelope.rcptTo.map((r) => r.address),
          raw,
        });
        cb();
      });
    },
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("SMTP server did not bind a port");

  return {
    port: address.port,
    certBase64: Buffer.from(cert, "utf8").toString("base64"),
    received,
    lastText() {
      const message = received[received.length - 1];
      if (!message) return "";
      const sep = message.raw.indexOf("\r\n\r\n");
      const body = sep >= 0 ? message.raw.slice(sep + 4) : message.raw;
      return decodeQuotedPrintable(body);
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
