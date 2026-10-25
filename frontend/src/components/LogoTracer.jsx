import { useId } from 'react';

// The OpenCAI mark, simplified: a cloud dome over an infinity loop, drawn as
// one stroke, and the circuit traces that branch off its top right.
const OUTLINE =
  'M6 28 C6 20 10 15 16 15 C17 8 22 4 29 4 C40 4 50 13 50 28 ' +
  'C50 33 46 36 42 36 C36 36 32 32 28 28 C24 24 20 20 14 20 C10 20 6 24 6 28 ' +
  'C6 32 10 36 14 36 C20 36 24 32 28 28 C32 24 36 20 42 20 C46 20 50 24 50 28';

const TRACES = [
  { d: 'M38.5 6.3 L42 2.5 L48 2.5', node: [50.5, 2.5] },
  { d: 'M43.6 10.4 L47 7 L52 7', node: [54.5, 7] },
  { d: 'M47.5 16.2 L50.5 12.5 L53.5 12.5', node: [56, 12.5] },
];

/**
 * A loader that traces the OpenCAI logo: the outline draws itself, the circuit
 * traces follow, and it all un-draws and loops. Decorative only; the caller
 * says what is loading.
 */
export function LogoTracer({ className = '' }) {
  const gradientId = useId();
  const stroke = `url(#${gradientId})`;

  return (
    <svg viewBox="0 0 58 40" fill="none" aria-hidden="true" className={`shrink-0 ${className}`}>
      <defs>
        <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1="0" y1="40" x2="58" y2="0">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
      </defs>
      <g stroke={stroke} strokeLinecap="round" strokeLinejoin="round">
        {/* The whole mark, faint, so the shape reads mid-trace. */}
        <g opacity="0.15">
          <path d={OUTLINE} strokeWidth="3.5" />
          {TRACES.map((t) => (
            <path key={t.d} d={t.d} strokeWidth="2" />
          ))}
        </g>
        <path d={OUTLINE} pathLength="1" strokeWidth="3.5" className="logo-tracer-outline" />
        {TRACES.map((t, i) => (
          <path
            key={t.d}
            d={t.d}
            pathLength="1"
            strokeWidth="2"
            className="logo-tracer-trace"
            style={{ animationDelay: `${i * 0.1}s` }}
          />
        ))}
      </g>
      {TRACES.map((t, i) => (
        <circle
          key={t.d}
          cx={t.node[0]}
          cy={t.node[1]}
          r="1.8"
          fill={stroke}
          className="logo-tracer-node"
          style={{ animationDelay: `${i * 0.1}s` }}
        />
      ))}
    </svg>
  );
}
