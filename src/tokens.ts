import { PublicKey } from "@solana/web3.js";
import { NATIVE_SOL_MINT } from "veilo-sdk-core";

export type TokenId = "SOL" | "USDC";

export interface TokenInfo {
  id: TokenId;
  label: string;
  mint: PublicKey;
  decimals: number;
}

const USDC_MINT = new PublicKey(
  import.meta.env.VITE_USDC_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);

export const TOKENS: Record<TokenId, TokenInfo> = {
  SOL:  { id: "SOL",  label: "SOL",  mint: NATIVE_SOL_MINT, decimals: 9 },
  USDC: { id: "USDC", label: "USDC", mint: USDC_MINT,       decimals: 6 },
};

export function toBaseUnits(amount: string, decimals: number): bigint {
  const [whole, frac = ""] = amount.trim().split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

export function fromBaseUnits(raw: bigint, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, "0");
  const i = s.length - decimals;
  return `${s.slice(0, i)}.${s.slice(i)}`.replace(/\.?0+$/, "");
}
