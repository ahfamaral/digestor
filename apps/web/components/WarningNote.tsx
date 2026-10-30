import type { ReactNode } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** R33: warnings are neutral (stone) with a ⚠ sign and text; colour stays reserved for highlight types. */
export const WARNING_BOX = "border-stone-300 bg-stone-50 text-stone-900";

/** The ⚠ sign that starts a warning (decorative: the text says what is wrong). */
export function WarningIcon({ className }: { className?: string }) {
  return <TriangleAlertIcon aria-hidden className={cn("size-4 shrink-0 text-stone-700", className)} />;
}

/** A warning line: ⚠ followed by its content, in the neutral warning box. */
export function WarningNote({ children, className, role }: { children: ReactNode; className?: string; role?: "status" | "note" }) {
  return (
    <div role={role} className={cn("flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-[13px]", WARNING_BOX, className)}>
      <WarningIcon className="mt-0.5" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
