import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "border-border bg-secondary/60 text-muted-foreground",
        accent: "border-primary/30 bg-primary/10 text-[oklch(0.78_0.12_255)]",
        good: "border-[var(--green)]/30 bg-[var(--green)]/10 text-[var(--green)]",
        warn: "border-[var(--amber)]/30 bg-[var(--amber)]/10 text-[var(--amber)]",
        destructive: "border-destructive/30 bg-destructive/10 text-[oklch(0.7_0.18_20)]",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge };
