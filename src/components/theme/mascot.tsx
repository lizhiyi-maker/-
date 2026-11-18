/** 吉祥物“团团”：圆滚滚的小团子，纯 SVG（颜色走 CSS 变量，随主题变色）。装饰用，对读屏隐藏。 */
export function Mascot({ size = 56, className = "", mood = "happy" }: { size?: number; className?: string; mood?: "happy" | "wow" | "sleepy" }) {
  const mouth = mood === "wow" ? "M55 80 Q60 90 65 80 Q60 76 55 80Z" : mood === "sleepy" ? "M54 80 Q60 82 66 80" : "M52 77 Q60 88 68 77";
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} aria-hidden focusable="false" className={`mascot ${className}`}>
      <ellipse cx="60" cy="110" rx="30" ry="6" fill="currentColor" opacity=".12" />
      <g className="mascot-bob">
        <line x1="60" y1="30" x2="60" y2="14" stroke="var(--mascot-line)" strokeWidth="3" strokeLinecap="round" />
        <circle cx="60" cy="11" r="6" fill="var(--mascot-accent)" stroke="var(--mascot-line)" strokeWidth="3" />
        <circle cx="30" cy="38" r="13" fill="var(--mascot-body)" stroke="var(--mascot-line)" strokeWidth="3" />
        <circle cx="90" cy="38" r="13" fill="var(--mascot-body)" stroke="var(--mascot-line)" strokeWidth="3" />
        <circle cx="30" cy="38" r="6" fill="var(--mascot-accent)" opacity=".55" />
        <circle cx="90" cy="38" r="6" fill="var(--mascot-accent)" opacity=".55" />
        <ellipse cx="60" cy="68" rx="43" ry="38" fill="var(--mascot-body)" stroke="var(--mascot-line)" strokeWidth="3" />
        <g className="mascot-eyes">
          <ellipse cx="45" cy="63" rx="5.5" ry="8" fill="var(--mascot-line)" />
          <ellipse cx="75" cy="63" rx="5.5" ry="8" fill="var(--mascot-line)" />
          <circle cx="47" cy="60" r="2" fill="#fff" />
          <circle cx="77" cy="60" r="2" fill="#fff" />
        </g>
        <ellipse cx="33" cy="76" rx="7" ry="4.5" fill="var(--mascot-blush)" opacity=".7" />
        <ellipse cx="87" cy="76" rx="7" ry="4.5" fill="var(--mascot-blush)" opacity=".7" />
        <path d={mouth} fill={mood === "wow" ? "var(--mascot-line)" : "none"} stroke="var(--mascot-line)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}
