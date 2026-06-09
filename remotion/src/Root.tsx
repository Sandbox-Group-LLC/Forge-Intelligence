import { Composition } from "remotion";
import { DataReel, totalDuration, dimsFor } from "./DataReel";
import type { VideoProps } from "./types";

// The single productized composition. renderMediaOnLambda passes
// inputProps = { brand, scenes } and calculateMetadata derives the duration,
// so the backend never has to compute frame counts.
const defaultProps: VideoProps = {
  brand: { name: "Forge Intelligence" },
  scenes: [
    {
      id: "hook", type: "hook", durationInFrames: 180,
      headline: "Brand intelligence that", emphasis: "compounds.",
      sub: "A living brand brain, on every cycle.",
    },
    {
      id: "cta", type: "cta", durationInFrames: 150,
      title: "Forge Intelligence", sub: "See it in action.",
      cta: "forgeintelligence.ai",
    },
  ],
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="DataReel"
    component={DataReel}
    defaultProps={defaultProps}
    fps={30}
    width={1920}
    height={1080}
    calculateMetadata={({ props }: { props: VideoProps }) => {
      const { width, height } = dimsFor(props.orientation);
      return { durationInFrames: totalDuration(props.scenes), width, height };
    }}
  />
);
