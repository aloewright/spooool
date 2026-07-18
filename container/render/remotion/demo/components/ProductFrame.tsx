import { Img, staticFile } from "remotion";

type ProductFrameMotion = Readonly<{
  opacity: number;
  scale: number;
  translateX: number;
  translateY: number;
}>;

type ProductFrameProps = Readonly<{
  imagePath: string;
  width: number;
  height: number;
  motion: ProductFrameMotion;
  objectPosition?: string;
}>;

export const ProductFrame = ({
  imagePath,
  width,
  height,
  motion,
  objectPosition = "center",
}: ProductFrameProps) => {
  return (
    <div
      style={{
        width,
        height,
        overflow: "hidden",
        border: "2px solid rgb(23 23 20 / 14%)",
        borderRadius: 28,
        boxSizing: "border-box",
        backgroundColor: "#FFFFFF",
        boxShadow: "0 28px 70px rgb(23 23 20 / 20%)",
        opacity: motion.opacity,
        scale: motion.scale,
        translate: `${motion.translateX}px ${motion.translateY}px`,
      }}
    >
      <div
        className="stack"
        style={{
          display: "flex",
          alignItems: "center",
          height: 52,
          padding: "0 18px",
          borderBottom: "2px solid rgb(23 23 20 / 10%)",
          backgroundColor: "#F2EFE5",
          boxSizing: "border-box",
          gap: 8,
        }}
      >
        {["#D58B3D", "#82937A", "#171714"].map((color) => (
          <span
            key={color}
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              backgroundColor: color,
            }}
          />
        ))}
        <div
          style={{
            height: 22,
            flex: 1,
            marginLeft: 8,
            borderRadius: 11,
            backgroundColor: "rgb(23 23 20 / 8%)",
          }}
        />
      </div>
      <Img
        src={staticFile(imagePath)}
        style={{
          display: "block",
          width: "100%",
          height: height - 52,
          objectFit: "cover",
          objectPosition,
        }}
      />
    </div>
  );
};
