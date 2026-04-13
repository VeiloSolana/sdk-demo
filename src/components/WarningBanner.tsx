export default function WarningBanner() {
  return (
    <div className="warn">
      ⚠️ Tutorial only — your shielded private key is stored in <code>localStorage</code>.
      Do not use this UI for real funds.
    </div>
  );
}
