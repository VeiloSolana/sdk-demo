interface Props { address: string; label: string }

export default function AddressCard({ address, label }: Props) {
  return (
    <div className="row">
      <label>{label}</label>
      <div className="addr" onClick={() => navigator.clipboard.writeText(address)}>
        {address}
      </div>
      <span className="muted">Click to copy</span>
    </div>
  );
}
