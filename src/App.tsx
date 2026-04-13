import { useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import TipJar from "./components/TipJar";
import Claim from "./components/Claim";
import WarningBanner from "./components/WarningBanner";

type Tab = "tip" | "claim";

export default function App() {
  const [tab, setTab] = useState<Tab>("tip");
  return (
    <div className="shell">
      <div className="wallet-bar">
        <WalletMultiButton />
      </div>
      <h1 className="title">Private Tip Jar</h1>
      <p className="subtitle">
        Deposit SOL or USDC into a shielded pool. Claim privately via the Veilo relayer.
      </p>
      <WarningBanner />
      <div className="tabs">
        <button
          className={`tab ${tab === "tip" ? "active" : ""}`}
          onClick={() => setTab("tip")}
        >
          Tip
        </button>
        <button
          className={`tab ${tab === "claim" ? "active" : ""}`}
          onClick={() => setTab("claim")}
        >
          Claim
        </button>
      </div>
      {tab === "tip" ? <TipJar /> : <Claim />}
    </div>
  );
}
