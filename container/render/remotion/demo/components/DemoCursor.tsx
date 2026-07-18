type DemoCursorProps = Readonly<{
  x: number;
  y: number;
  scale: number;
  opacity: number;
}>;

export const DemoCursor = ({ x, y, scale, opacity }: DemoCursorProps) => {
  return (
    <svg
      aria-hidden
      viewBox="0 0 42 54"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: 42,
        height: 54,
        overflow: "visible",
        pointerEvents: "none",
        filter: "drop-shadow(0 5px 5px rgb(23 23 20 / 26%))",
        opacity,
        scale,
        translate: `${x}px ${y}px`,
      }}
    >
      <path
        d="M4 3 36 31l-14 2 8 16-8 4-8-16-10 10Z"
        fill="#FFFFFF"
        stroke="#171714"
        strokeLinejoin="round"
        strokeWidth="4"
      />
    </svg>
  );
};
