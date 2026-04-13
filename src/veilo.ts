import { Connection } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
// Namespace import: the SDK's package.json declares `"type": "commonjs"` but
// ships an ESM build, so named imports of re-exported classes (like
// VeiloRelayerClient) occasionally come through as `undefined` through Vite's
// dep-optimizer. Pulling everything through a namespace dodges that.
import * as Veilo from "veilo-sdk-core";
import type { MerkleTree as MerkleTreeT } from "veilo-sdk-core";
// @ts-expect-error snarkjs ships no types
import * as snarkjs from "snarkjs";
const {
  createVeiloProgram,
  formatInputsForSnarkjs,
  MerkleTree,
  VeiloRelayerClient,
} = Veilo;

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
