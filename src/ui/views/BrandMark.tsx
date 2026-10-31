/**
 * The Sovo mark ("Field S"): an S picked out of a 4×5 grid, the unused cells
 * left faint so the grid shows. Drawn inline, so it paints with the first
 * frame and takes the theme's text colour. The app icon and README mark are
 * the same drawing in docs/brand/.
 */
const ON = new Set(['0,1', '0,2', '0,3', '1,0', '2,1', '2,2', '3,3', '4,0', '4,1', '4,2'])
const ACCENT = '0,3'
const CELLS = Array.from({ length: 20 }, (_, i) => [Math.floor(i / 4), i % 4] as const)

export function BrandMark({ className, size = 44 }: { className?: string; size?: number }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="22 18 56 64"
      role="img"
      aria-label="Sovo"
    >
      {CELLS.map(([r, c]) => {
        const key = `${r},${c}`
        return (
          <rect
            key={key}
            x={27.5 + c * 12}
            y={21.5 + r * 12}
            width={9}
            height={9}
            rx={2.5}
            fill={key === ACCENT ? '#8B7CF6' : 'currentColor'}
            opacity={ON.has(key) ? 1 : 0.14}
          />
        )
      })}
    </svg>
  )
}
