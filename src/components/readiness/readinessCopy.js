import {
  BatteryMedium,
  Flame,
  Moon,
  Smile,
  Zap,
} from "lucide-react";

export const wellnessIcons = {
  soreness: Flame,
  fatigue: BatteryMedium,
  mood: Smile,
  stress: Zap,
  sleep: Moon,
};

export const wellnessScaleLabels = {
  1: "Very poor",
  2: "Below avg",
  3: "Okay",
  4: "Good",
  5: "Excellent",
};

export const readinessStyles = {
  red: "border-red-300/40 bg-red-300/10 text-red-100",
  yellow: "border-amber-300/40 bg-amber-300/10 text-amber-100",
  green: "border-lime-300/40 bg-lime-300/10 text-lime-100",
};

export const readinessCopy = {
  green: {
    label: "Green",
    title: "Green Readiness - Push performance",
    body: "Recovery signals look good. Follow the plan and progress normally if performance is there.",
    guidance:
      "Readiness is strong. Follow the planned loads and push progression where performance supports it.",
    summary:
      "Recovery signals look good. Follow the plan and progress normally if performance is there.",
  },
  yellow: {
    label: "Yellow",
    title: "Yellow Readiness - Train normally, stay controlled",
    body: "You can train productively today, but avoid forcing progression if performance feels off.",
    guidance:
      "Train normally, but stay controlled. Beat last session if it feels earned, not forced.",
    summary:
      "Train productively, but avoid forcing progression if performance feels off.",
  },
  red: {
    label: "Red",
    title: "Red Readiness - Protect quality",
    body: "Readiness is low. Keep technique sharp and use conservative progression today.",
    guidance:
      "Keep quality high today. Consider using the lower end of the rep ranges, avoid forced PR attempts, and reduce accessory effort if fatigue is obvious.",
    summary: "Readiness is low. Keep technique sharp and use conservative progression today.",
  },
};

export function getReadinessCopy(readiness) {
  return readinessCopy[readiness?.status] ?? readinessCopy.yellow;
}
