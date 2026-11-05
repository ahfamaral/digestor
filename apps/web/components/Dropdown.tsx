"use client";

import { Fragment } from "react";
import { cn } from "cn";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";

export type DropdownOption<V extends string> = {
  value: V;
  label: string;
  /** BCP-47 tag when the label is a language name written in that language. */
  lang?: string;
  title?: string;
  /** Options with the same group are listed together under its heading. */
  group?: string;
};

type Props<V extends string> = {
  value: V;
  onValueChange: (value: V) => void;
  options: DropdownOption<V>[];
  "aria-label"?: string;
  "aria-describedby"?: string;
  id?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
};

/** The one dropdown of the app (Base UI Select): white popup, keyboard and screen-reader ready. */
export function Dropdown<V extends string>({ value, onValueChange, options, size = "md", className, id, disabled, ...aria }: Props<V>) {
  const items = options.map((o) => ({ value: o.value, label: o.label }));
  const groups: { name: string | undefined; options: DropdownOption<V>[] }[] = [];
  for (const o of options) {
    const last = groups[groups.length - 1];
    if (last && last.name === o.group) last.options.push(o);
    else groups.push({ name: o.group, options: [o] });
  }
  const selected = options.find((o) => o.value === value);
  const item = (o: DropdownOption<V>) => (
    <SelectItem key={o.value} value={o.value} lang={o.lang} title={o.title} className="text-foreground">
      {o.label}
    </SelectItem>
  );
  return (
    <Select<V> value={value} onValueChange={(v) => v !== null && onValueChange(v as V)} items={items} disabled={disabled}>
      <SelectTrigger
        id={id}
        size={size === "sm" ? "sm" : "default"}
        aria-label={aria["aria-label"]}
        aria-describedby={aria["aria-describedby"]}
        className={cn(
          "w-full min-w-0 border-border bg-white font-sans text-foreground dark:bg-white",
          size === "sm" ? "text-xs" : "text-base md:text-sm",
          className,
        )}
      >
        <SelectValue lang={selected?.lang} className="min-w-0 truncate" />
      </SelectTrigger>
      <SelectContent
        alignItemWithTrigger={false}
        align="start"
        className="w-auto max-w-[min(92vw,28rem)] border border-border bg-white font-sans ring-0"
      >
        {groups.map((g, i) =>
          g.name ? (
            <SelectGroup key={`${g.name}:${i}`}>
              <SelectLabel>{g.name}</SelectLabel>
              {g.options.map(item)}
            </SelectGroup>
          ) : (
            <Fragment key={i}>{g.options.map(item)}</Fragment>
          ),
        )}
      </SelectContent>
    </Select>
  );
}
