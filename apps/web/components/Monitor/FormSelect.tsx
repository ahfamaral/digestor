"use client";

import { useId, useState } from "react";
import { Dropdown } from "@/components/Dropdown";

/**
 * A filter choice inside a GET search form, drawn with the app's `Dropdown` (not the browser's select). The choice
 * travels in a hidden field named `name`; "Any" is the empty value, which `GetForm` leaves out of the address.
 * `lang`: the options' language (official values are Portuguese).
 */
export function FormSelect({
  name, label, anyLabel, options, value, lang, className,
}: { name: string; label: string; anyLabel: string; options: string[]; value: string | null; lang?: string; className?: string }) {
  const id = useId();
  const [chosen, setChosen] = useState(value ?? "");
  return (
    <div className={`grid min-w-0 gap-1 text-sm ${className ?? ""}`}>
      <label htmlFor={id} className="text-muted-foreground">{label}</label>
      <Dropdown
        id={id}
        value={chosen}
        onValueChange={setChosen}
        options={[{ value: "", label: anyLabel }, ...options.map((o) => ({ value: o, label: o, lang }))]}
        className="data-[size=default]:h-9 focus-visible:border-stone-500 focus-visible:ring-stone-500"
      />
      <input type="hidden" name={name} value={chosen} />
    </div>
  );
}
