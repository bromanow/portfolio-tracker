// Small inline trend line for a stat or table row — not a full chart (no axes, no
// legend; a single series names itself via the label next to it). Color follows the
// status convention used everywhere else in the app (pnlClass: emerald/red/neutral),
// not the categorical palette, since it's encoding gain/loss, not series identity.
export default function Sparkline({
  data, width = 72, height = 24, className = '',
}: {
  data: number[]
  width?: number
  height?: number
  className?: string
}) {
  const clean = data.filter(n => Number.isFinite(n))
  if (clean.length < 2) return null

  const min = Math.min(...clean)
  const max = Math.max(...clean)
  const span = max - min || 1
  const padY = 2
  const scaleX = (i: number) => (i / (clean.length - 1)) * width
  const scaleY = (v: number) => height - padY - ((v - min) / span) * (height - padY * 2)

  const points = clean.map((v, i) => [scaleX(i), scaleY(v)] as const)
  const linePath = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L${width},${height} L0,${height} Z`

  const trendUp = clean[clean.length - 1] >= clean[0]
  const colorClass = trendUp ? 'text-emerald-500 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'
  const [lastX, lastY] = points[points.length - 1]

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={`${colorClass} ${className}`}
      preserveAspectRatio="none"
    >
      <title>{`${clean[0].toLocaleString()} → ${clean[clean.length - 1].toLocaleString()}`}</title>
      <path d={areaPath} fill="currentColor" opacity="0.12" stroke="none" />
      <path
        d={linePath}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={lastX} cy={lastY} r="1.75" fill="currentColor" />
    </svg>
  )
}
