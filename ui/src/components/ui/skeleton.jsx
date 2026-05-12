import * as React from "react";

import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }) {
  return (
    <div
      data-slot="skeleton"
      className={cn("bg-accent/60 animate-pulse rounded-md", className)}
      {...props}
    />
  );
}

export { Skeleton };
