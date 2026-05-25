/**
 * @module @outpost/shared/crypto
 *
 * Cryptographic primitives for Outpost: Ed25519 key generation, signing,
 * envelope creation/verification, and helper digests.
 *
 * @remarks
 * All signing uses Node.js built-in `crypto` with Ed25519 keys in PEM format.
 * No external crypto libraries are required.
 */

import {
  createHash,
  randomBytes,
  sign,
  verify,
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  timingSafeEqual
} from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SignedEnvelope } from "@outpost/protocol";
import { PROTOCOL_VERSION } from "@outpost/protocol";
import { pathExists } from "./fs.js";

/**
 * PEM-encoded Ed25519 key pair.
 */
export type KeyPairPem = {
  /** Private key in PKCS#8 PEM format. */
  privateKeyPem: string;
  /** Public key in SPKI PEM format. */
  publicKeyPem: string;
};

/**
 * Generates a cryptographically random identifier.
 *
 * @param prefix - Optional prefix appended before the random segment.
 * @returns A base64url-encoded 128-bit random identifier.
 */
export function randomId(prefix = ""): string {
  const id = randomBytes(16).toString("base64url");
  return prefix ? `${prefix}_${id}` : id;
}

/**
 * Generates a fresh Ed25519 signing key pair.
 *
 * @returns PEM-encoded key pair.
 */
export function generateSigningKeyPair(): KeyPairPem {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString()
  };
}

/**
 * Loads an existing key pair from disk, or generates and persists a new one.
 *
 * @param privatePath - Filesystem path for the private key.
 * @param publicPath - Filesystem path for the public key.
 * @returns The loaded or newly-created key pair.
 *
 * @remarks
 * The private key is written with mode `0o600`; the public key with `0o644`.
 */
export async function ensureSigningKeyPair(
  privatePath: string,
  publicPath: string
): Promise<KeyPairPem> {
  if ((await pathExists(privatePath)) && (await pathExists(publicPath))) {
    return {
      privateKeyPem: await readFile(privatePath, "utf8"),
      publicKeyPem: await readFile(publicPath, "utf8")
    };
  }
  const keyPair = generateSigningKeyPair();
  await mkdir(dirname(privatePath), { recursive: true });
  await writeFile(privatePath, keyPair.privateKeyPem, { mode: 0o600 });
  await writeFile(publicPath, keyPair.publicKeyPem, { mode: 0o644 });
  await chmod(privatePath, 0o600);
  return keyPair;
}

/**
 * Derives a stable peer ID from a PEM public key.
 *
 * @param publicKeyPem - Public key in PEM format.
 * @returns SHA-256 digest encoded as base64url.
 */
export function peerIdFromPublicKey(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem).digest("base64url");
}

/**
 * Computes the SHA-256 hex digest of a string.
 *
 * @param value - Input string.
 * @returns Lower-case hex digest.
 */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Constant-time string comparison to mitigate timing attacks.
 *
 * @param a - First string.
 * @param b - Second string.
 * @returns `true` only when the strings are identical in length and content.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function canonicalEnvelopePayload(envelope: Omit<SignedEnvelope, "signature">): string {
  return JSON.stringify(envelope);
}

/**
 * Creates a signed envelope wrapping an arbitrary payload.
 *
 * @param input - Envelope construction parameters.
 * @returns A fully-signed envelope ready for wire transmission.
 *
 * @remarks
 * The envelope automatically includes `protocolVersion`, `messageId`, `issuedAt`,
 * `expiresAt`, and a random `nonce`.  The default TTL is 60 seconds.
 */
export function createSignedEnvelope<TPayload>(input: {
  senderId: string;
  recipientId: string;
  privateKeyPem: string;
  payload: TPayload;
  ttlMs?: number;
}): SignedEnvelope<TPayload> {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + (input.ttlMs ?? 60_000));
  const unsigned: Omit<SignedEnvelope<TPayload>, "signature"> = {
    protocolVersion: PROTOCOL_VERSION,
    messageId: randomId("msg"),
    senderId: input.senderId,
    recipientId: input.recipientId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    nonce: randomId("nonce"),
    payload: input.payload
  };
  const signature = sign(
    null,
    Buffer.from(canonicalEnvelopePayload(unsigned)),
    createPrivateKey(input.privateKeyPem)
  ).toString("base64url");
  return { ...unsigned, signature };
}

/**
 * Verifies a signed envelope: protocol version, sender/recipient match,
 * expiration, and Ed25519 signature.
 *
 * @param input - Verification parameters.
 * @throws Error with a descriptive message when any check fails.
 */
export function verifySignedEnvelope<TPayload>(input: {
  envelope: SignedEnvelope<TPayload>;
  publicKeyPem: string;
  expectedSenderId?: string;
  expectedRecipientId?: string;
  now?: Date;
}): void {
  const { signature, ...unsigned } = input.envelope;
  if (unsigned.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error("Unsupported protocol version");
  }
  if (input.expectedSenderId && unsigned.senderId !== input.expectedSenderId) {
    throw new Error("Envelope sender does not match the pinned key");
  }
  if (input.expectedRecipientId && unsigned.recipientId !== input.expectedRecipientId) {
    throw new Error("Envelope recipient does not match this outpost");
  }
  const now = input.now ?? new Date();
  if (
    Number.isNaN(Date.parse(unsigned.expiresAt)) ||
    new Date(unsigned.expiresAt).getTime() < now.getTime()
  ) {
    throw new Error("Envelope has expired");
  }
  const ok = verify(
    null,
    Buffer.from(canonicalEnvelopePayload(unsigned)),
    createPublicKey(input.publicKeyPem),
    Buffer.from(signature, "base64url")
  );
  if (!ok) {
    throw new Error("Envelope signature verification failed");
  }
}
