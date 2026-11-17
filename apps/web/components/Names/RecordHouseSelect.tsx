"use client";

import { useEffect, useState } from "react";
import { CHAMBERS, CHAMBER_IDS, chamberLabel, type ChamberId } from "@digestor/core";
import { t } from "@/lib/i18n";
import { Dropdown } from "@/components/Dropdown";

/** What the select holds: a house, or "" for "Detect from the link". */
export type RecordHouse = ChamberId | "";

const STORAGE_KEY = "digestor.recordChamber";

/** "Detect from the link", then the five houses grouped by country (in the display order of `CHAMBER_IDS`). */
export function recordHouseGroups() {
  const groups: { country: string; options: { value: ChamberId; label: string }[] }[] = [];
  for (const id of CHAMBER_IDS) {
    const country = CHAMBERS[id].countryName;
    let group = groups.find((g) => g.country === country);
    if (!group) groups.push((group = { country, options: [] }));
    group.options.push({ value: id, label: chamberLabel(id) });
  }
  return { detect: { value: "" as const, label: t("upload.recordHouseDetect") }, groups };
}

/** The help under the field: one example per form the picked house accepts. */
export function recordHelpText(house: RecordHouse): string {
  return t(`upload.recordHelpByHouse.${house || "detect"}`);
}

/** Does the text hold a link? Then the house is read from it, so the select goes back to "Detect from the link". */
export function holdsLink(text: string): boolean {
  return /(^|\s)(https?:\/\/|www\.)\S/i.test(text);
}

/** The house the journalist picked last time, kept in the browser; the page works without it. */
export function useRecordHouse(): [RecordHouse, (house: RecordHouse) => void, (house: RecordHouse) => void] {
  const [house, setHouse] = useState<RecordHouse>("");
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read after hydration on purpose (a lazy initial state would mismatch the server HTML)
      if (saved && (CHAMBER_IDS as string[]).includes(saved)) setHouse(saved as RecordHouse);
    } catch {
      // storage blocked: the select starts on "Detect from the link"
    }
  }, []);
  /** A pick of the journalist: shown and remembered. */
  const pick = (next: RecordHouse) => {
    setHouse(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // not remembered
    }
  };
  /** Shown only (a link in the box): the remembered pick stays. */
  const show = (next: RecordHouse) => setHouse(next);
  return [house, pick, show];
}

export function RecordHouseSelect({ id, value, disabled, describedBy, onChange }: { id: string; value: RecordHouse; disabled?: boolean; describedBy?: string; onChange: (house: RecordHouse) => void }) {
  const { detect, groups } = recordHouseGroups();
  return (
    <div className="w-full">
      <label htmlFor={id} className="block text-xs text-muted-foreground">
        {t("upload.recordHouse")}
      </label>
      <Dropdown
        id={id}
        className="mt-1"
        value={value}
        disabled={disabled}
        aria-describedby={describedBy}
        onValueChange={onChange}
        options={[
          { value: detect.value as RecordHouse, label: detect.label },
          ...groups.flatMap((g) => g.options.map((o) => ({ value: o.value as RecordHouse, label: o.label, group: g.country }))),
        ]}
      />
    </div>
  );
}
