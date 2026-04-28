import { Connection } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import nacl from "tweetnacl";
// Namespace import: the SDK's package.json declares `"type": "commonjs"` but
// ships an ESM build, so named imports of re-exported classes (like
// VeiloRelayerClient) occasionally come through as `undefined` through Vite's
// dep-optimizer. Pulling everything through a namespace dodges that.
import * as Veilo from "veilo-sdk-core";
import type { MerkleTree as MerkleTreeT } from "veilo-sdk-core";
// @ts-expect-error snarkjs ships no types
import * as snarkjs from "snarkjs";
import { loadStoredKeypair, saveKeypair } from "./storage";

const {
  createVeiloProgram,
  formatInputsForSnarkjs,
  MerkleTree,
  VeiloRelayerClient,
  initPoseidon,
  generateKeypair,
  derivePublicKey,
  deriveEncryptionKeypair,
} = Veilo;

// bigIntToBytesBE is a plain function — safe to pull directly from the namespace.
export const bigIntToBytesBE = (Veilo as any).bigIntToBytesBE as (
  n: bigint,
) => Uint8Array;

// Start loading the Poseidon WASM at module load time so it's ready before
// any Merkle tree construction or keypair generation.
const veiloReady = (initPoseidon as () => Promise<void>)();

/**
 * Read-only helpers that don't need a signer.
 * `createVeiloProgram` accepts an anchor.Wallet-compatible object, so for
 * read paths we pass a minimal stub — it only uses `.publicKey`.
 */
export const connection = new Connection(
  import.meta.env.VITE_RPC_URL ?? "https://api.devnet.solana.com",
  { commitment: "confirmed" },
);

export const relayerClient = new VeiloRelayerClient({
  relayerUrl:
    import.meta.env.VITE_VEILO_RELAYER_URL ??
    "https://relayer-server.onrender.com",
  apiKey: import.meta.env.VITE_VEILO_API_KEY ?? "",
  relayerPublicKey: import.meta.env.VITE_VEILO_RELAYER_PUBKEY ?? "",
});

console.log(
  "relayerUrl ",
  import.meta.env.VITE_VEILO_RELAYER_URL,
  " apiKey ",
  import.meta.env.VITE_VEILO_API_KEY,
  " relayerPublicKey ",
  import.meta.env.VITE_VEILO_RELAYER_PUBKEY,
);

/**
 * Transaction proof builder. Uses the SDK's `formatInputsForSnarkjs` to
 * build the witness object, then hands it to snarkjs directly.
 */
const WASM_PATH = "/circuits/transaction/transaction_js/transaction.wasm";
const ZKEY_PATH = "/circuits/transaction/transaction_final.zkey";

export const proofBuilder = async (inputs: unknown) => {
  const formatted = formatInputsForSnarkjs(inputs as any);
  const { proof } = await snarkjs.groth16.fullProve(
    formatted,
    WASM_PATH,
    ZKEY_PATH,
  );
  return proof;
};

/**
 * Return the locally-stored veilo keypair, generating and persisting a new
 * one if this is the first visit. Awaits Poseidon WASM initialisation first.
 */
export async function ensureVeiloKeypair(): Promise<{
  privateKey: string;
  publicKey: string;
}> {
  await veiloReady;
  const existing = loadStoredKeypair();
  if (existing) {
    // Always recompute publicKey from privateKey — guards against stale stored
    // values from sessions where Poseidon wasn't fully initialised yet.
    const recomputed = (derivePublicKey as (pk: bigint) => bigint)(BigInt(existing.privateKey));
    const keypair = { privateKey: existing.privateKey, publicKey: recomputed.toString() };
    if (keypair.publicKey !== existing.publicKey) {
      saveKeypair(keypair);
    }
    return keypair;
  }
  const kp = (generateKeypair as () => { privateKey: bigint; publicKey: bigint })();
  const keypair = {
    privateKey: kp.privateKey.toString(),
    publicKey: kp.publicKey.toString(),
  };
  saveKeypair(keypair);
  return keypair;
}

/**
 * Build a Veilo program bound to the connected wallet. This is the object
 * that `deposit()` uses to sign and submit the on-chain transaction.
 */
export function getProgram(wallet: WalletContextState) {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error("Wallet not connected");
  }
  // wallet-adapter's WalletContextState is structurally compatible with
  // anchor.Wallet (publicKey, signTransaction, signAllTransactions).
  return createVeiloProgram(connection, wallet as any, {
    commitment: "confirmed",
  });
}

/**
 * Rebuild the local Merkle tree for a given mint by pulling every leaf from
 * the relayer. This keeps our in-memory tree in sync with chain state so the
 * next deposit produces valid zero-knowledge proofs.
 */
export async function loadTreeForMint(
  mintAddress: string,
): Promise<MerkleTreeT> {
  await veiloReady;
  const tree = new MerkleTree(22);
  const res = await relayerClient.getMerkleTree(mintAddress);
  if (!res.success) return tree;
  // Leaves arrive in commitment order — insert them sequentially.
  const leaves = [...res.data.leaves].sort((a, b) => a.index - b.index);
  for (const leaf of leaves) {
    tree.insert(commitmentToBytes(leaf.commitment));
  }
  return tree;
}

function commitmentToBytes(s: string): Uint8Array {
  // Try hex first (with or without 0x prefix), then base64, then base58.
  const hex = s.startsWith("0x") ? s.slice(2) : s;
  if (hex.length === 64 && /^[0-9a-fA-F]+$/.test(hex)) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  if (/^[A-Za-z0-9+/]+=*$/.test(s)) {
    try {
      const bin = atob(s);
      if (bin.length === 32) {
        const out = new Uint8Array(32);
        for (let i = 0; i < 32; i++) out[i] = bin.charCodeAt(i);
        return out;
      }
    } catch {
      // fall through
    }
  }
  const decoded = bs58.decode(s);
  if (decoded.length !== 32) {
    throw new Error(`commitment is ${decoded.length} bytes, expected 32`);
  }
  return decoded;
}

// =============================================================================
// Note encryption / decryption for the tip-jar
// =============================================================================

function _fromBase64(s: string): Uint8Array {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function _toBase64(bytes: Uint8Array): string {
  // Use Buffer when available (Node/polyfill) to avoid spread-arg stack limit.
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Return the base64-encoded NaCl X25519 encryption public key for a Veilo
 * private key. Deterministic — same private key always gives the same result.
 */
export function getVeiloNaclPublicKey(privateKey: bigint): string {
  const { publicKey } = (deriveEncryptionKeypair as (pk: bigint) => { publicKey: Uint8Array; secretKey: Uint8Array })(privateKey);
  return _toBase64(publicKey);
}

/**
 * Encrypt an arbitrary JSON-serializable note blob for a recipient identified
 * by their Veilo NaCl X25519 public key (base64-encoded).
 *
 * Wire format:  [nonce (24 bytes)] [NaCl box ciphertext]  — base64 in encryptedBlob.
 * ephemeralPublicKey is the sender's one-use NaCl X25519 public key (base64).
 */
export function encryptNoteBlob(
  noteData: object,
  recipientNaclPubkeyB64: string,
): { ephemeralPublicKey: string; encryptedBlob: string } {
  const recipientPubkey = _fromBase64(recipientNaclPubkeyB64);
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const plaintext = new TextEncoder().encode(JSON.stringify(noteData));
  const ciphertext = nacl.box(plaintext, nonce, recipientPubkey, ephemeral.secretKey);

  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce);
  combined.set(ciphertext, nonce.length);

  return {
    ephemeralPublicKey: _toBase64(ephemeral.publicKey),
    encryptedBlob: _toBase64(combined),
  };
}

/**
 * Decrypt a note blob encrypted by encryptNoteBlob, using the recipient's
 * Veilo private key. Returns the parsed JSON, or throws on failure.
 */
export function decryptNoteBlob(
  ephemeralPublicKeyB64: string,
  encryptedBlobB64: string,
  recipientPrivateKey: bigint,
): unknown {
  const { secretKey } = (deriveEncryptionKeypair as (pk: bigint) => { publicKey: Uint8Array; secretKey: Uint8Array })(recipientPrivateKey);
  const ephemeralPubkey = _fromBase64(ephemeralPublicKeyB64);
  const combined = _fromBase64(encryptedBlobB64);
  const nonce = combined.slice(0, nacl.box.nonceLength);
  const ciphertext = combined.slice(nacl.box.nonceLength);
  const plaintext = nacl.box.open(ciphertext, nonce, ephemeralPubkey, secretKey);
  if (!plaintext) throw new Error("Note decryption failed — wrong key or corrupted blob");
  return JSON.parse(new TextDecoder().decode(plaintext));
}
