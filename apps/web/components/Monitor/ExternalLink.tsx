import { ExternalLink as Icon } from "lucide-react";

/** A link to the Câmara's own public page, opened in a new tab. */
export function ExternalLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1 rounded underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-stone-500 ${className ?? ""}`}
    >
      {children}
      <Icon className="size-3.5 shrink-0" aria-hidden />
    </a>
  );
}
