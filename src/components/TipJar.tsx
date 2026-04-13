import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { deposit } from "veilo-sdk-core";
import { TOKENS, TokenId, toBaseUnits } from "../tokens";
import { getProgram, loadTreeForMint, proofBuilder } from "../veilo";

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

  async function handleDeposit() {
    setError(null);
    setReceipt(null);
    if (!wallet.publicKey) {
      setError("Connect a wallet first.");
      return;
    }
    setBusy(true);
    try {
      const token = TOKENS[tokenId];
      const program = getProgram(wallet);

      // Sync the local Merkle tree with chain state before proving.
      const tree = await loadTreeForMint(token.mint.toBase58());

      // Deposit: builds the SNARK proof client-side, then submits the
      // Anchor transaction that inserts the commitment on-chain.
      const result = await deposit({
        program,
        depositor: wallet as any,
        amount: toBaseUnits(amount, token.decimals),
        mintAddress: token.mint,
        recipientPubkey: BigInt(recipient),
        tree,
        proofBuilder,
      });

      setReceipt({
        txLabel: `${amount} ${token.label}`,
        commitment: bytesToHex(result.outputUTXOs[0].commitment),
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
        <select value={tokenId} onChange={(e) => setTokenId(e.target.value as TokenId)}>
          <option value="SOL">SOL</option>
          <option value="USDC">USDC</option>
        </select>
      </div>
      <div className="row">
        <label>Amount</label>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.1" />
      </div>
      <div className="row">
        <label>Recipient shielded pubkey</label>
        <input
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="Paste the tip-jar address from the Claim tab"
        />
      </div>
      <button className="primary" onClick={handleDeposit} disabled={busy || !recipient}>
        {busy ? "Proving & depositing…" : "Send tip"}
      </button>

      {error && <div className="status err">{error}</div>}
      {receipt && (
        <div className="status">
          <div className="kv"><span>Deposited</span><span>{receipt.txLabel}</span></div>
          <div className="kv"><span>Leaf index</span><span className="mono">{receipt.leafIndex}</span></div>
          <div className="kv"><span>Commitment</span><span className="mono">{shorten(receipt.commitment)}</span></div>
          <div className="kv"><span>New root</span><span className="mono">{shorten(receipt.root)}</span></div>
        </div>
      )}
    </div>
  );
}

function bytesToHex(b: Uint8Array): string {
  return "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function shorten(s: string): string {
  return s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-8)}` : s;
}
