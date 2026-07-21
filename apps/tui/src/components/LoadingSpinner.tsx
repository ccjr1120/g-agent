import React, { useEffect, useState } from "react";
import { Text } from "ink";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function formatElapsed(ms: number): string {
  if (ms <= 0) {
    return "0.0s";
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}m${remainder}s`;
}

export function LoadingSpinner({
  label,
  color = "yellow",
  startMs,
  dim = false,
}: {
  label: string;
  color?: string;
  startMs?: number;
  dim?: boolean;
}) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % SPINNER_FRAMES.length);
    }, 140);

    return () => clearInterval(timer);
  }, []);

  // The spinner's own animation interval re-renders this component, so the
  // elapsed value recomputes on every frame — no extra timer needed.
  const elapsed = startMs ? formatElapsed(Date.now() - startMs) : null;
  const glyph = SPINNER_FRAMES[frame];
  const tail = elapsed ? ` ${elapsed}` : "";

  if (dim) {
    return <Text dimColor>{`${glyph}${tail}`}</Text>;
  }

  const labelText = elapsed ? `${label} ${elapsed}` : label;

  return (
    <Text>
      <Text color={color}>{glyph}</Text>
      <Text dimColor>
        {" "}
        {labelText}
      </Text>
    </Text>
  );
}
