import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import { deposit } from "veilo-sdk-core";
import { TOKENS, TokenId, toBaseUnits } from "../tokens";
import { connection, getProgram, loadTreeForMint, proofBuilder, relayerClient, bigIntToBytesBE, encryptNoteBlob } from "../veilo";

interface DepositReceipt {
  txLabel: string;
  commitment: string;
  leafIndex: number;
  root: string;
}

export default function TipJar() {
  const wallet = useWallet();
  const [tokenId, setTokenId] = useState<TokenId>("SOL");
  const [amount, setAmount] = useState("0.1");
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<DepositReceipt | null>(null);

  // Tip-jar address format: `${veiloCircuitPubKey}|${naclEncPubKeyBase64}|${solanaWalletBase58}`
  function parseTipJarAddress(addr: string): { vpk: string; epk: string; wpk: string } | null {
    const parts = addr.trim().split("|");
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
    return { vpk: parts[0], epk: parts[1], wpk: parts[2] };
  }

  async function handleDeposit() {
    setError(null);
    setReceipt(null);
    if (!wallet.publicKey || !wallet.signTransaction) {
      setError("Connect a wallet that supports signing.");
      return;
    }
    const parsed = parseTipJarAddress(recipient);
    if (!parsed) {
      setError("Invalid tip-jar address — paste the full address from the recipient's Claim tab.");
      return;
    }
    const { vpk, epk, wpk } = parsed;
    setBusy(true);
    try {
      const token = TOKENS[tokenId];
      const program = getProgram(wallet);

      // Sync the local Merkle tree with chain state before proving.
      const tree = await loadTreeForMint(token.mint.toBase58());

      // Build the deposit transaction (proof + unsigned Solana tx). The SDK
      // intentionally does not submit — we sign with wallet-adapter ourselves
      // and only commit the new leaves to the local tree after confirmation.
      const { transaction, commit } = await deposit({
        program,
        depositor: { publicKey: wallet.publicKey },
        amount: toBaseUnits(amount, token.decimals),
        mintAddress: token.mint,
        recipientPubkey: BigInt(vpk),
        tree,
        proofBuilder,
      });

      const signed = await wallet.signTransaction(transaction);
      const rawTx = signed.serialize();

      // sendRawTransaction runs preflight simulation; if the tx was already
      // submitted and confirmed (e.g. after a network hiccup + retry), the
      // simulation returns "already been processed". In that case we recover
      // the signature from the signed bytes and skip re-sending.
      let sig: string;
      try {
        sig = await connection.sendRawTransaction(rawTx);
      } catch (e: any) {
        if (!e.message?.includes("already been processed")) throw e;
        const sigBytes: Uint8Array =
          (signed as any).signature ?? (signed as any).signatures?.[0];
        sig = bs58.encode(sigBytes);
      }
      await connection.confirmTransaction(sig, "confirmed");

      const result = commit();

      // Encrypt the note blob to the recipient's Veilo NaCl encryption key.
      const outputUTXO = result.outputUTXOs[0];
      const commitmentHex = toHex(outputUTXO.commitment);
      const blindingHex = toHex(bigIntToBytesBE(outputUTXO.blinding));
      const noteTimestamp = Date.now();
      const { ephemeralPublicKey, encryptedBlob } = encryptNoteBlob(
        {
          amount: outputUTXO.amount.toString(),
          blinding: blindingHex,
          commitment: commitmentHex,
          leafIndex: result.leafIndices[0],
          timestamp: noteTimestamp,
          recipientVeiloPublicKey: vpk,
        },
        epk,
      );

      await relayerClient.saveEncryptedNote({
        commitment: commitmentHex,
        ephemeralPublicKey,
        encryptedBlob,
        timestamp: noteTimestamp,
        txSignature: sig,
        recipientWalletPublicKey: wpk,
      });

      setReceipt({
        txLabel: `${amount} ${token.label}`,
        commitment: "0x" + commitmentHex,
        leafIndex: result.leafIndices[0],
        root: bytesToHex(result.root),
      });
    } catch (e: any) {
      console.error(e);
      setError(e.message ?? "Deposit failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="row">
        <label>Token</label>
        <select
          value={tokenId}
          onChange={(e) => setTokenId(e.target.value as TokenId)}
        >
          <option value="SOL">SOL</option>
          <option value="USDC">USDC</option>
        </select>
      </div>
      <div className="row">
        <label>Amount</label>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.1"
        />
      </div>
      <div className="row">
        <label>Recipient tip-jar address</label>
        <input
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="Paste the full tip-jar address from the recipient's Claim tab"
        />
      </div>
      <button
        className="primary"
        onClick={handleDeposit}
        disabled={busy || !recipient}
      >
        {busy ? "Proving & depositing…" : "Send tip"}
      </button>

      {error && <div className="status err">{error}</div>}
      {receipt && (
        <div className="status">
          <div className="kv">
            <span>Deposited</span>
            <span>{receipt.txLabel}</span>
          </div>
          <div className="kv">
            <span>Leaf index</span>
            <span className="mono">{receipt.leafIndex}</span>
          </div>
          <div className="kv">
            <span>Commitment</span>
            <span className="mono">{shorten(receipt.commitment)}</span>
          </div>
          <div className="kv">
            <span>New root</span>
            <span className="mono">{shorten(receipt.root)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function toHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToHex(b: Uint8Array): string {
  return "0x" + toHex(b);
}
function shorten(s: string): string {
  return s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-8)}` : s;
}
