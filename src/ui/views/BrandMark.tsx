/**
 * The Sovo mark ("Field S"): an S picked out of a 4×5 grid, the unused cells
 * left faint so the grid shows. Drawn inline, so it paints with the first
 * frame and takes the theme's text colour. The app icon and README mark are
 * the same drawing in docs/brand/.
 */
const ON = new Set(['0,1', '0,2', '0,3', '1,0', '2,1', '2,2', '3,3', '4,0', '4,1', '4,2'])
const ACCENT = '0,3'
const CELLS = Array.from({ length: 20 }, (_, i) => [Math.floor(i / 4), i % 4] as const)
/** The order a pen would draw the S, from the violet cell to the bottom left. */
const STROKE = ['0,3', '0,2', '0,1', '1,0', '2,1', '2,2', '3,3', '4,2', '4,1', '4,0']

/**
 * `animate` draws it in: the faint grid settles first, then the S lights cell
 * by cell along its stroke (CSS `.bm-cell`, delays in `--d`).
 * `loading` loops instead: a light runs along the stroke and fades
 * (CSS `.bm-load`, position in `--i`). It wins over `animate`.
 */
export function BrandMark({
  className,
  size = 44,
  animate = false,
  loading = false,
  label = 'Sovo'
}: {
  className?: string
  size?: number
  animate?: boolean
  loading?: boolean
  label?: string
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="22 18 56 64"
      role="img"
      aria-label={label}
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
            className={
              loading ? (ON.has(key) ? 'bm-load' : undefined) : animate ? (ON.has(key) ? 'bm-cell bm-on' : 'bm-cell') : undefined
            }
            style={
              loading
                ? ON.has(key)
                  ? ({ '--i': STROKE.indexOf(key) } as React.CSSProperties)
                  : undefined
                : animate
                  ? ({ '--d': `${ON.has(key) ? 260 + STROKE.indexOf(key) * 55 : (r + c) * 25}ms` } as React.CSSProperties)
                  : undefined
            }
          />
        )
      })}
    </svg>
  )
}
