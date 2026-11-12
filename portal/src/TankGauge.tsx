import { useId } from 'react';
import { productName } from './tanks';
import { Ic, num } from './ui';

/** Without a known tank height the scale is drawn over 3 m, so the metre reading is the fill level on that scale. */
const DEFAULT_SCALE_METRES = 3;

// the interior of the tank in the drawing, which is where the liquid and the scale line up
const IN = { x: 34, y: 46, w: 204, h: 98 };
const WAVE_LENGTH = 60;

function wavePath(top: number) {
  const left = IN.x - WAVE_LENGTH;
  const right = IN.x + IN.w + WAVE_LENGTH;
  const bottom = IN.y + IN.h + 4;
  let d = `M ${left} ${bottom} L ${left} ${top}`;
  for (let x = left; x <= right; x += 5) d += ` L ${x} ${(top + 2.6 * Math.sin(((x - left) / WAVE_LENGTH) * 2 * Math.PI)).toFixed(2)}`;
  return `${d} L ${right} ${bottom} Z`;
}

export interface TankGaugeProps {
  product: string;
  tankNo: number;
  site?: string;
  percent: number;
  bookLitres: number;
  capacityLitres: number;
  reorderLitres?: number;
  temperatureC?: number | null;
  waterMm?: number | null;
  belowReorder?: boolean;
  /** Product height measured by the probe; when given, the marker shows it instead of a level derived from percent. */
  productHeightMm?: number | null;
  /** Configured tank height; sets the scale. */
  tankHeightMm?: number | null;
  /** Extra line under the gauge, such as the probe status and alarms. */
  note?: string;
}

export default function TankGauge({
  product, tankNo, site, percent, bookLitres, capacityLitres, reorderLitres, temperatureC, waterMm, belowReorder,
  productHeightMm, tankHeightMm, note,
}: TankGaugeProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const SCALE_METRES = tankHeightMm && tankHeightMm > 0 ? tankHeightMm / 1000 : DEFAULT_SCALE_METRES;
  const step = SCALE_METRES / 6;
  const MAJOR_TICKS = Array.from({ length: 7 }, (_, i) => i * step);
  const level = Math.min(Math.max(percent, 0), 100);
  const levelMetres = productHeightMm != null && tankHeightMm ? Math.min(productHeightMm / 1000, SCALE_METRES)
    : (level / 100) * SCALE_METRES;
  const yOf = (metres: number) => IN.y + IN.h - (metres / SCALE_METRES) * IN.h;
  const liquidTop = yOf(levelMetres);
  const liquidHeight = IN.y + IN.h - liquidTop;
  const diesel = product.startsWith('DIESEL');
  const ullage = Math.max(capacityLitres - bookLitres, 0);
  const markerY = liquidTop;
  const markerLabel = `${(productHeightMm != null ? productHeightMm / 1000 : levelMetres).toFixed(2)} m`;

  return (
    <section className={`card tank-card${belowReorder ? ' low' : ''}`}>
      <header className="tg-head">
        <span className="tg-pump"><Ic n="fuel" s={26} /></span>
        <div className="tg-title">
          <h2>{productName(product)}</h2>
          {site && <small>{site}</small>}
        </div>
        <span className="tg-pill">{belowReorder && <i className="tg-low">Low level</i>}Tank {String(tankNo).padStart(2, '0')}</span>
      </header>

      <svg className="tg-svg" viewBox="0 0 360 184" role="img"
        aria-label={`${productName(product)} tank ${tankNo} is ${num(level, 0)}% full, ${num(bookLitres, 0)} of ${num(capacityLitres, 0)} litres`}>
        <defs>
          <linearGradient id={`${uid}metal`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f7f9fa" /><stop offset="0.35" stopColor="#aeb6bd" />
            <stop offset="0.6" stopColor="#e4e8ea" /><stop offset="1" stopColor="#7b858d" />
          </linearGradient>
          <linearGradient id={`${uid}liquid`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={diesel ? '#ffd84d' : '#8dff3d'} />
            <stop offset="1" stopColor={diesel ? '#d98b00' : '#18a21a'} />
          </linearGradient>
          <linearGradient id={`${uid}glass`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#233a40" /><stop offset="1" stopColor="#0f1d21" />
          </linearGradient>
          <clipPath id={`${uid}clip`}><rect x={IN.x} y={IN.y} width={IN.w} height={IN.h} rx="36" /></clipPath>
        </defs>

        {/* legs and base plates */}
        <path d="M62 152 L100 152 L106 172 L56 172 Z" fill={`url(#${uid}metal)`} />
        <path d="M170 152 L208 152 L214 172 L164 172 Z" fill={`url(#${uid}metal)`} />
        <rect x="48" y="171" width="64" height="6" rx="2" fill="#6d767e" />
        <rect x="158" y="171" width="64" height="6" rx="2" fill="#6d767e" />

        {/* filler cap and valve */}
        <rect x="68" y="24" width="38" height="16" rx="3" fill={`url(#${uid}metal)`} stroke="#8a949b" />
        <rect x="64" y="20" width="46" height="7" rx="3" fill={`url(#${uid}metal)`} stroke="#8a949b" />
        <rect x="177" y="22" width="6" height="18" fill="#9aa3aa" />
        <rect x="165" y="15" width="30" height="8" rx="4" fill="#dc2f2f" />

        {/* shell and glass interior */}
        <rect x="22" y="36" width="228" height="118" rx="46" fill={`url(#${uid}metal)`} stroke="#8a949b" />
        <rect x={IN.x} y={IN.y} width={IN.w} height={IN.h} rx="36" fill={`url(#${uid}glass)`} />

        <g clipPath={`url(#${uid}clip)`}>
          {liquidHeight > 0 && (
            <>
              <g className="tg-wave"><path d={wavePath(liquidTop)} fill={`url(#${uid}liquid)`} /></g>
              {liquidHeight > 26 && [0, 1, 2, 3, 4, 5].map((k) => (
                <circle key={k} cx={58 + k * 31} cy={liquidTop + 14 + ((k * 17) % Math.max(liquidHeight - 22, 6))} r={2 + (k % 3)}
                  fill="none" stroke="#fff" strokeOpacity="0.55" />
              ))}
            </>
          )}
          {reorderLitres != null && capacityLitres > 0 && (
            <line x1={IN.x} x2={IN.x + IN.w} y1={yOf((reorderLitres / capacityLitres) * SCALE_METRES)} y2={yOf((reorderLitres / capacityLitres) * SCALE_METRES)}
              stroke="#ff8a7a" strokeWidth="1" strokeDasharray="4 4"><title>Reorder level</title></line>
          )}
          <rect x={IN.x + 8} y={IN.y + 5} width={IN.w - 16} height="9" rx="4.5" fill="#fff" opacity="0.14" />
        </g>

        {/* metre scale */}
        <line x1="258" x2="258" y1={yOf(SCALE_METRES)} y2={yOf(0)} stroke="#5c6670" />
        {Array.from({ length: 13 }, (_, i) => i * (step / 2)).map((m, i) => (
          <line key={m} x1="258" x2={i % 2 === 0 ? 266 : 262} y1={yOf(m)} y2={yOf(m)} stroke="#5c6670" />
        ))}
        {MAJOR_TICKS.filter((m) => Math.abs(m - levelMetres) > SCALE_METRES * 0.07).map((m) => (
          <text key={m} x="272" y={yOf(m) + 4} className="tg-scale">{m.toFixed(2)} m</text>
        ))}
        <g transform={`translate(0 ${markerY})`}>
          <path d="M262 0 L272 -9 L272 9 Z" fill="#b3125f" />
          <rect x="271" y="-10" width="76" height="20" rx="5" fill="#b3125f" />
          <text x="309" y="4.5" textAnchor="middle" className="tg-marker">{markerLabel}</text>
        </g>
      </svg>

      <div className="tg-stats">
        <div><small>Level</small><b className="tg-accent">{num(level, 0)}%</b></div>
        <div><small>Volume</small><b>{num(bookLitres, 0)} L</b></div>
        <div><small>Capacity (L)</small><b>{num(capacityLitres, 0)} L</b></div>
      </div>
      <div className="tg-stats tg-two">
        <div className="tg-icon"><span><Ic n="thermo" s={30} /></span>
          <div><small>Temperature</small><b>{temperatureC != null ? `${num(temperatureC)} °C` : '—'}</b></div></div>
        <div className="tg-icon"><span><Ic n="stack" s={30} /></span>
          <div><small>Ullage</small><b>{num(ullage, 0)} L</b></div></div>
      </div>
      <small className="tg-foot">
        Reorder at {reorderLitres != null ? `${num(reorderLitres, 0)} L` : '—'} · Water {waterMm != null ? `${num(waterMm)} mm` : '—'}
        {note && <><br />{note}</>}
      </small>
    </section>
  );
}
