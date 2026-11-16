import { initials } from "@/lib/monitor/directory";
import { cn } from "@/lib/utils";

/**
 * A deputy's photo on a neutral circle that shows their initials until the photo has loaded (lazily) or when there is
 * none, so a list never reads as empty white circles. Decorative: the name is always written beside it.
 */
export function Avatar({ name, photoUrl, size, lazy = false }: { name: string; photoUrl: string | null; size: 32 | 40; lazy?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-stone-100 font-medium text-muted-foreground select-none",
        size === 40 ? "size-10 text-sm" : "size-8 text-xs",
      )}
    >
      {initials(name)}
      {photoUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- the Câmara's photo, shown as published
        <img
          src={photoUrl}
          alt=""
          width={size}
          height={size}
          loading={lazy ? "lazy" : undefined}
          decoding="async"
          referrerPolicy="no-referrer"
          className="absolute inset-0 size-full object-cover object-top"
        />
      )}
    </span>
  );
}
