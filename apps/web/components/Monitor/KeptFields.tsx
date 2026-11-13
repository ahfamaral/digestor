import { deputyHref, type DeputyParams } from "@/lib/monitor/params";

/**
 * Hidden fields carrying what a section's form keeps of the deputy page (`keptBy`): the other sections' searches,
 * filters and pages, so filtering the votes doesn't drop the speech search. Same keys and order as `deputyHref`.
 */
export function KeptFields({ params }: { params: DeputyParams }) {
  const query = new URLSearchParams(deputyHref(0, params).split("?")[1] ?? "");
  return (
    <>
      {[...query].map(([name, value], i) => (
        <input key={`${name}:${i}`} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}
