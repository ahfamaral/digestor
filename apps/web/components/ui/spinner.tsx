import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** Small loading icon. It keeps showing (without spinning) when the system asks for reduced motion. */
export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-hidden className={cn("size-3.5 shrink-0 motion-safe:animate-spin", className)} />;
}

/** A waiting label: the spinner goes before the text while `busy`; the text always stays. */
export function Busy({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <>
      {busy && <Spinner className="mr-1.5 in-data-[slot=button]:mr-0" />}
      {children}
    </>
  );
}
