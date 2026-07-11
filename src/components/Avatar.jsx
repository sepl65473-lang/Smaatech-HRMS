import { initials, gradientFor } from '../lib/helpers';

export default function Avatar({ name, size = 38, className = '', photo = '' }) {
  if (photo) {
    return (
      <div
        className={`avatar ${className}`}
        style={{ width: size, height: size, padding: 0, overflow: 'hidden' }}
      >
        <img
          src={photo}
          alt={name}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      </div>
    );
  }

  return (
    <div
      className={`avatar ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.34),
        background: gradientFor(name),
      }}
    >
      {initials(name)}
    </div>
  );
}
