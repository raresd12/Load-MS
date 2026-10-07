import {
  BatteryMedium,
  Flame,
  Moon,
  Smile,
  Zap,
} from "lucide-react";
import { READINESS_SAVED_MESSAGE } from "../../lib/readinessSave.js";

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

/**
 * Colour of the Readiness page save line (decisions HV-1, HV-11): the
 * success confirmation of a durable save is good, any other message from the
 * save (a refused or failed write) is bad, and the idle status line is text-2.
 */
export function readinessSaveMessageClass(message) {
  if (!message) {
    return "text-text-2";
  }

  return message === READINESS_SAVED_MESSAGE ? "text-good" : "text-bad";
}

export const readinessStyles = {
  red: "border-bad/40 bg-bad-tint text-bad",
  yellow: "border-warn/40 bg-warn-tint text-warn",
  green: "border-good/40 bg-good-tint text-good",
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
