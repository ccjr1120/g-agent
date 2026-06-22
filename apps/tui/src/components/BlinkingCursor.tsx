import React, { useEffect, useState } from "react";
import { Text } from "ink";

export function BlinkingCursor() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setInterval(() => {
      setVisible((current) => !current);
    }, 500);

    return () => clearInterval(timer);
  }, []);

  return <Text inverse={visible}> </Text>;
}
