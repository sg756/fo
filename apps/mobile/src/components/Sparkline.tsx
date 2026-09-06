import { useId, useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop, Circle } from 'react-native-svg';
import { useTheme } from '../theme/ThemeContext';

type Props = {
  data: number[];
  positive: boolean;
  width?: number;
  height?: number;
};

type Pt = { x: number; y: number };

/** Catmull-Rom → 三次贝塞尔，曲线更顺滑 */
function smoothPath(points: Pt[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }

  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

/** 点太少时线性插值，避免折线生硬 */
function densify(data: number[], minPoints = 16): number[] {
  const clean = data.filter((n) => Number.isFinite(n));
  if (clean.length < 2) return clean;
  if (clean.length >= minPoints) return clean;
  const out: number[] = [];
  const segments = clean.length - 1;
  for (let i = 0; i < minPoints; i++) {
    const t = (i / (minPoints - 1)) * segments;
    const i0 = Math.floor(t);
    const i1 = Math.min(segments, i0 + 1);
    const f = t - i0;
    out.push(clean[i0] * (1 - f) + clean[i1] * f);
  }
  return out;
}

export function Sparkline({ data, positive, width = 72, height = 32 }: Props) {
  const { theme } = useTheme();
  const gradId = useId().replace(/:/g, '');
  const color = positive ? theme.success : theme.danger;

  const { line, area, last } = useMemo(() => {
    const series = densify(data.length >= 2 ? data : [40, 42, 45, 48]);
    const min = Math.min(...series);
    const max = Math.max(...series);
    const range = max - min || 1;
    const padX = 2;
    const padY = 3;
    const innerW = width - padX * 2;
    const innerH = height - padY * 2;

    const points: Pt[] = series.map((v, i) => ({
      x: padX + (i / (series.length - 1)) * innerW,
      y: padY + (1 - (v - min) / range) * innerH,
    }));

    const linePath = smoothPath(points);
    const lastPt = points[points.length - 1];
    const areaPath = `${linePath} L ${lastPt.x} ${height - 1} L ${points[0].x} ${height - 1} Z`;
    return { line: linePath, area: areaPath, last: lastPt };
  }, [data, width, height]);

  return (
    <View style={{ width, height }}>
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor={color} stopOpacity={0.28} />
            <Stop offset="55%" stopColor={color} stopOpacity={0.08} />
            <Stop offset="100%" stopColor={color} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Path d={area} fill={`url(#${gradId})`} />
        <Path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <Circle cx={last.x} cy={last.y} r={2.2} fill={color} />
      </Svg>
    </View>
  );
}
