export default function Placeholder({ title, note }) {
  return (
    <div className="page-wrap active">
      <div className="card" style={{ textAlign: 'center', padding: '64px 24px' }}>
        <div className="card-title" style={{ fontSize: 22 }}>{title}</div>
        <div className="card-sub" style={{ marginTop: 8 }}>{note}</div>
      </div>
    </div>
  );
}
